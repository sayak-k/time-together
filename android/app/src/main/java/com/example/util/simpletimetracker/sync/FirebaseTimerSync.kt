package com.example.util.simpletimetracker.sync

import android.app.Activity
import android.app.Application
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.widget.Toast
import com.example.util.simpletimetracker.domain.color.mapper.AppColorMapper
import com.example.util.simpletimetracker.domain.color.model.AppColor
import com.example.util.simpletimetracker.domain.notifications.interactor.UpdateExternalViewsInteractor
import com.example.util.simpletimetracker.domain.record.interactor.RecordsUpdateInteractor
import com.example.util.simpletimetracker.domain.record.interactor.RunningRecordInteractor
import com.example.util.simpletimetracker.domain.record.interactor.TimerSyncBridge
import com.example.util.simpletimetracker.domain.record.model.Record
import com.example.util.simpletimetracker.domain.record.model.RunningRecord
import com.example.util.simpletimetracker.domain.record.repo.RecordRepo
import com.example.util.simpletimetracker.domain.recordType.model.RecordType
import com.example.util.simpletimetracker.domain.recordType.repo.RecordTypeRepo
import com.example.util.simpletimetracker.domain.prefs.interactor.PrefsInteractor
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.android.gms.tasks.Task
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.FirebaseFirestoreSettings
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.MetadataChanges
import com.google.firebase.firestore.QuerySnapshot
import dagger.hilt.android.qualifiers.ApplicationContext
import java.security.MessageDigest
import java.util.UUID
import javax.inject.Inject
import javax.inject.Provider
import javax.inject.Singleton
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** Online-only, single-timer sync. Firestore is authoritative; Room is its native UI projection. */
@Singleton
class FirebaseTimerSync @Inject constructor(
    @ApplicationContext private val context: Context,
    private val bridge: TimerSyncBridge,
    private val types: RecordTypeRepo,
    private val records: RecordRepo,
    private val running: RunningRecordInteractor,
    private val updates: RecordsUpdateInteractor,
    private val externalViews: Provider<UpdateExternalViewsInteractor>,
    private val colors: AppColorMapper,
    private val appPrefs: PrefsInteractor,
) : TimerSyncBridge.Handler {
    private val prefs = context.getSharedPreferences("firebase_timer_sync", Context.MODE_PRIVATE)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val projectionMutex = Mutex()
    private val actionMutex = Mutex()
    private var listeners = listOf<ListenerRegistration>()
    private var generation = 0
    private var activeId: String? = null
    private var serverState = false
    private var serverSessions = false
    private var foregroundActivities = 0
    private var signedInUid: String? = null
    var auth: FirebaseAuth? = null
        private set
    private var db: FirebaseFirestore? = null
    var status = "Firebase is not configured yet."
        private set
    override val enabled get() = prefs.getBoolean("enabled", false)
    val configured get() = db != null
    val email get() = auth?.currentUser?.email
    val ready get() = enabled && auth?.currentUser != null && serverState && serverSessions

    fun initialize(application: Application) {
        bridge.handler = this
        try {
            val json = JSONObject(context.assets.open("firebase.config.json").bufferedReader().use { it.readText() })
            val options = FirebaseOptions.Builder().setApiKey(json.getString("androidApiKey"))
                .setApplicationId(json.getString("androidAppId")).setProjectId(json.getString("projectId")).build()
            val app = FirebaseApp.initializeApp(context, options, "timer-sync")
            auth = FirebaseAuth.getInstance(app)
            db = FirebaseFirestore.getInstance(app).apply {
                firestoreSettings = FirebaseFirestoreSettings.Builder().setPersistenceEnabled(false).build()
            }
            status = "Sign in to connect your timers."
            auth!!.addAuthStateListener { firebaseAuth ->
                val uid = firebaseAuth.currentUser?.uid
                val locked = prefs.getString("account", null)
                if (uid != null && locked != null && uid != locked) {
                    firebaseAuth.signOut()
                    status = "This installation is linked to another account. Use that account or clear this app's data."
                } else {
                    signedInUid = uid
                    disconnect()
                    if (foregroundActivities > 0) connect()
                }
            }
        } catch (_: java.io.FileNotFoundException) {
            status = "Firebase setup is pending. Configure this build before signing in."
        } catch (error: Exception) {
            status = "Could not configure Firebase: ${error.message}"
        }
        application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) { foregroundActivities++; if (foregroundActivities == 1) connect() }
            override fun onActivityStopped(activity: Activity) { foregroundActivities--; if (foregroundActivities == 0) disconnect() }
            override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
    }

    suspend fun signIn(email: String, password: String, create: Boolean) {
        val auth = requireNotNull(auth) { "Firebase is not configured." }
        if (create) auth.createUserWithEmailAndPassword(email.trim(), password).await()
        else auth.signInWithEmailAndPassword(email.trim(), password).await()
        val uid = requireNotNull(auth.currentUser).uid
        val locked = prefs.getString("account", null)
        check(locked == null || locked == uid) { "Use the account already linked to this installation." }
        status = "Signed in. Enable sync to begin."
    }

    suspend fun enable() = withContext(Dispatchers.IO) {
        val uid = requireNotNull(auth?.currentUser) { "Sign in first." }.uid
        if (!enabled) check(running.isEmpty()) { "Stop your local timers before enabling sync." }
        // Preserve installation/account identity before any projection is written.
        check(prefs.edit().putString("account", uid).putBoolean("enabled", true).commit())
        signedInUid = uid
        connect()
    }

    fun signOut() { disconnect(); auth?.signOut(); status = "Signed out. Sign in again to use synced timers." }

    private fun connect() {
        if (!enabled || listeners.isNotEmpty()) return
        val uid = auth?.currentUser?.uid ?: return
        val db = db ?: return
        signedInUid = uid
        val token = generation
        status = "Connecting…"
        listeners = listOf(
            db.collection("users/$uid/activities").addSnapshotListener(MetadataChanges.INCLUDE) { snapshot, error ->
                if (token != generation) return@addSnapshotListener
                if (error != null) { fail(error); return@addSnapshotListener }
                if (snapshot != null && !snapshot.metadata.isFromCache) scope.launch {
                    try { projectionMutex.withLock {
                        if (token != generation) return@withLock
                        withContext(Dispatchers.IO) {
                            snapshot.documents.forEach { ensureType(uid, it.id, it.getString("name")!!, it.getString("color")!!) }
                        }
                        updates.send()
                    } } catch (e: Exception) { fail(e) }
                }
            },
            db.document("users/$uid/state/timer").addSnapshotListener(MetadataChanges.INCLUDE) { snapshot, error ->
                if (token != generation) return@addSnapshotListener
                if (error != null) { fail(error); return@addSnapshotListener }
                activeId = snapshot?.getString("activeSessionId")
                serverState = snapshot != null && !snapshot.metadata.isFromCache
                updateStatus()
            },
            db.collection("users/$uid/sessions").addSnapshotListener(MetadataChanges.INCLUDE) { snapshot, error ->
                if (token != generation) return@addSnapshotListener
                if (error != null) { fail(error); return@addSnapshotListener }
                serverSessions = snapshot != null && !snapshot.metadata.isFromCache
                if (snapshot != null && serverSessions) scope.launch {
                    try { projectionMutex.withLock {
                        if (token != generation) return@withLock
                        withContext(Dispatchers.IO) { projectSessions(uid, snapshot) }
                    }; updateStatus() } catch (e: Exception) { fail(e) }
                }
                updateStatus()
            },
        )
    }

    private fun disconnect() {
        generation++
        listeners.forEach { it.remove() }; listeners = emptyList()
        serverState = false; serverSessions = false
    }

    private fun updateStatus() { status = if (ready) "Connected. One active timer across your devices." else "Connecting. Start and stop need an internet connection." }
    private fun fail(error: Exception) { serverState = false; serverSessions = false; status = "Sync failed: ${error.message}" }

    suspend fun importActivities() = withContext(Dispatchers.IO) {
        val uid = requireNotNull(auth?.currentUser) { "Sign in first." }.uid
        val db = requireNotNull(db)
        var install = prefs.getString("installation", null)
        if (install == null) { install = UUID.randomUUID().toString(); check(prefs.edit().putString("installation", install).commit()) }
        types.getAll().filter { !it.hidden }.forEach { type ->
            val cloudId = cloudIdForType(uid, type.id) ?: "android-$install-${type.id}"
            rememberType(uid, cloudId, type.id)
            val ref = db.document("users/$uid/activities/$cloudId")
            val state = db.document("users/$uid/state/timer")
            val color = String.format("#%06x", colors.mapToColorInt(type.color) and 0xffffff)
            retryRuleRace { db.runTransaction { tx ->
                val activity = tx.get(ref); val currentState = tx.get(state)
                if (!activity.exists()) tx.set(ref, mapOf("name" to type.name.take(80), "color" to color, "createdAt" to FieldValue.serverTimestamp()))
                if (!currentState.exists()) tx.set(state, mapOf("activeSessionId" to null, "revision" to 0L, "updatedAt" to FieldValue.serverTimestamp()))
            } }
        }
        status = "Activities imported. Past local records remain on this phone."
    }

    override suspend fun start(typeId: Long, comment: String): Boolean = actionMutex.withLock {
        guarded {
            check(ready) { "Open Time Together and wait for a connection before starting." }
            check(!appPrefs.getRetroactiveTrackingMode()) { "Turn off retroactive tracking to use synced timers." }
            check(types.get(typeId)?.defaultDuration == 0L) { "Remove this activity's default duration to use it as a synced timer." }
            val uid = requireNotNull(auth?.currentUser).uid
            val cloudId = cloudIdForType(uid, typeId) ?: error("Import this activity from the Time Together connection screen first.")
            val db = requireNotNull(db)
            val expected = activeId
            val requestId = UUID.randomUUID().toString()
            val state = db.document("users/$uid/state/timer")
            val session = db.document("users/$uid/sessions/$requestId")
            retryRuleRace { db.runTransaction { tx ->
                val currentState = tx.get(state)
                if (tx.get(session).exists()) return@runTransaction
                val currentId = currentState.getString("activeSessionId")
                val currentRef = currentId?.let { db.document("users/$uid/sessions/$it") }
                val current = currentRef?.let { tx.get(it) }
                if (current?.getString("activityId") == cloudId) return@runTransaction
                check(currentId == expected) { "The timer changed on another device. Review it and try again." }
                val activity = tx.get(db.document("users/$uid/activities/$cloudId"))
                check(activity.exists()) { "This activity is unavailable." }
                if (currentRef != null) tx.update(currentRef, "endedAt", FieldValue.serverTimestamp())
                tx.set(session, mapOf("activityId" to cloudId, "name" to activity.getString("name"), "color" to activity.getString("color"),
                    "comment" to comment.take(2000), "startedAt" to FieldValue.serverTimestamp(), "endedAt" to null))
                tx.set(state, mapOf("activeSessionId" to requestId, "revision" to ((currentState.getLong("revision") ?: 0) + 1), "updatedAt" to FieldValue.serverTimestamp()))
            } }
        }
    }

    override suspend fun stop(typeId: Long, startedAt: Long) {
        actionMutex.withLock { guarded {
            check(ready) { "Open Time Together and wait for a connection before stopping." }
            val uid = requireNotNull(auth?.currentUser).uid
            val cloudId = cloudIdForType(uid, typeId) ?: error("This is a local timer. It is not synced.")
            val db = requireNotNull(db)
            val expected = activeId ?: return@guarded
            val state = db.document("users/$uid/state/timer")
            val ref = db.document("users/$uid/sessions/$expected")
            retryRuleRace { db.runTransaction { tx ->
                val currentState = tx.get(state)
                val session = tx.get(ref)
                if (!session.exists() || session.getTimestamp("endedAt") != null) return@runTransaction
                check(session.getString("activityId") == cloudId &&
                    session.getTimestamp("startedAt")!!.toDate().time / 1000 == startedAt / 1000) {
                    "This timer changed on another device. Refresh before stopping."
                }
                check(currentState.getString("activeSessionId") == expected) { "The active timer changed. Try again." }
                tx.update(ref, "endedAt", FieldValue.serverTimestamp())
                tx.set(state, mapOf("activeSessionId" to null, "revision" to (currentState.getLong("revision")!! + 1), "updatedAt" to FieldValue.serverTimestamp()))
            } }
        } }
    }

    private suspend fun <T> retryRuleRace(action: () -> Task<T>): T = try {
        action().await()
    } catch (error: FirebaseFirestoreException) {
        if (error.code != FirebaseFirestoreException.Code.PERMISSION_DENIED) throw error
        action().await()
    }

    override suspend fun reject(message: String) {
        status = message
        withContext(Dispatchers.Main) { Toast.makeText(context, message, Toast.LENGTH_LONG).show() }
    }

    private suspend fun guarded(action: suspend () -> Unit): Boolean = try {
        action(); true
    } catch (cancelled: CancellationException) { throw cancelled
    } catch (error: Exception) {
        status = error.message ?: "Could not sync this action."
        withContext(Dispatchers.Main) { Toast.makeText(context, status, Toast.LENGTH_LONG).show() }; false
    }

    private suspend fun projectSessions(uid: String, snapshot: QuerySnapshot) {
        val runningIds = mutableSetOf<Long>()
        snapshot.documents.forEach { session ->
            val cloudId = session.getString("activityId") ?: return@forEach
            val typeId = ensureType(uid, cloudId, session.getString("name")!!, session.getString("color")!!)
            val startedAt = session.getTimestamp("startedAt")?.toDate()?.time ?: return@forEach
            val endedAt = session.getTimestamp("endedAt")?.toDate()?.time
            val comment = session.getString("comment").orEmpty()
            if (endedAt == null) {
                runningIds.add(typeId)
                val stagedIds = prefs.getStringSet("running_ids", emptySet()).orEmpty() + typeId.toString()
                check(prefs.edit().putStringSet("running_ids", stagedIds).commit())
                running.add(RunningRecord(typeId, startedAt, comment, emptyList()))
            } else {
                // Deterministic IDs make reconnect/replay/crash recovery an upsert, never a duplicate.
                records.add(Record(stableId("session:$uid:${session.id}"), typeId, startedAt, endedAt, comment, emptyList()))
            }
        }
        val previousIds = prefs.getStringSet("running_ids", emptySet()).orEmpty().mapNotNull { it.toLongOrNull() }
        previousIds.filter { it !in runningIds }.forEach { running.remove(it) }
        check(prefs.edit().putStringSet("running_ids", runningIds.map { it.toString() }.toSet()).commit())
        updates.send()
        externalViews.get().onAppStart()
    }

    private suspend fun ensureType(uid: String, cloudId: String, name: String, color: String): Long {
        val key = "type:$uid:$cloudId"
        val id = prefs.getLong(key, stableId(key))
        if (types.get(id) == null) {
            types.add(RecordType(id, name, name.take(1), AppColor(0, Color.parseColor(color).toString()), 0L, "Synced activity"))
        }
        rememberType(uid, cloudId, id)
        return id
    }

    private fun rememberType(uid: String, cloudId: String, id: Long) {
        check(prefs.edit().putLong("type:$uid:$cloudId", id).putString("cloud:$uid:$id", cloudId).commit())
    }
    private fun cloudIdForType(uid: String, id: Long) = prefs.getString("cloud:$uid:$id", null)
    private fun stableId(value: String): Long {
        val bytes = MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
        var result = 0L
        for (i in 0..6) result = (result shl 8) or (bytes[i].toLong() and 0xff)
        return result or (1L shl 60)
    }
}
