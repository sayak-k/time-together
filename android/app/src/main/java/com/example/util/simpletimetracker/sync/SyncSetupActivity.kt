package com.example.util.simpletimetracker.sync

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.example.util.simpletimetracker.ui.MainActivity
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@AndroidEntryPoint
class SyncSetupActivity : ComponentActivity() {
    @Inject lateinit var sync: FirebaseTimerSync
    private lateinit var status: TextView
    private lateinit var email: EditText
    private lateinit var password: EditText
    private val actions = mutableListOf<Button>()
    private var busy = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (24 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad * 2, pad, pad)
            setBackgroundColor(Color.rgb(245, 243, 236))
        }
        fun text(value: String, size: Float = 15f) = TextView(this).apply {
            text = value; textSize = size; setTextColor(Color.rgb(40, 62, 54)); setPadding(0, 14, 0, 14)
            column.addView(this)
        }
        text("Time Together", 32f)
        text("Your Android timers, connected to the web.")
        status = text(sync.status)
        email = EditText(this).apply { hint = "Email"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS; setSingleLine(); column.addView(this) }
        password = EditText(this).apply { hint = "Password"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD; setSingleLine(); column.addView(this) }
        fun button(label: String, block: suspend () -> Unit) {
            val button = Button(this).apply {
                this.text = label
                setOnClickListener { lifecycleScope.launch {
                    if (busy) return@launch
                    busy = true; actions.forEach { it.isEnabled = false }
                    try { block(); status.text = sync.status } catch (error: Exception) { status.text = error.message }
                    finally { busy = false; actions.forEach { it.isEnabled = sync.configured } }
                } }
            }
            actions.add(button); column.addView(button)
        }
        button("Sign in") { sync.signIn(email.text.toString(), password.text.toString(), false); password.text.clear() }
        button("Create account") {
            check(password.text.length >= 8) { "Choose a password with at least 8 characters." }
            sync.signIn(email.text.toString(), password.text.toString(), true); password.text.clear()
        }
        button("1. Import this phone's activities") { sync.importActivities() }
        button("2. Enable sync") { sync.enable() }
        button("Open timers") {
            check(sync.enabled && sync.auth?.currentUser != null) { "Sign in and enable sync first." }
            startActivity(Intent(this@SyncSetupActivity, MainActivity::class.java))
        }
        button("Sign out") { sync.signOut() }
        text("First version: one active timer, online start/stop, activity names, colours, notes and new session history. Create activities on the web, or create them in Android and import them here.", 13f)
        text("Past local history, edits, tags, goals and Pomodoro settings are not synced. Use the regular start/stop controls; synced sessions use the current time. Background notifications catch up when you reopen this app.", 13f)
        text("This is a separate installation. Your original Simple Time Tracker app remains available. To reuse its activities, restore a backup in this app before enabling sync.", 13f)
        val local = Button(this).apply { this.text = "Open local app / restore backup"; setOnClickListener {
            if (!sync.enabled) startActivity(Intent(this@SyncSetupActivity, MainActivity::class.java))
            else status.text = "Sync is enabled. Use Open timers above."
        } }; column.addView(local)
        setContentView(ScrollView(this).apply { addView(column) })
        actions.forEach { it.isEnabled = sync.configured }
        lifecycleScope.launch { while (true) {
            delay(3000)
            if (!busy && sync.ready) status.text = "${sync.email}\n${sync.status}"
            val signedIn = sync.auth?.currentUser != null
            email.visibility = if (signedIn) View.GONE else View.VISIBLE
            password.visibility = if (signedIn) View.GONE else View.VISIBLE
        } }
    }
}
