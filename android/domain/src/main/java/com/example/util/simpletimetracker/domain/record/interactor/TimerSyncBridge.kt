package com.example.util.simpletimetracker.domain.record.interactor

import javax.inject.Inject
import javax.inject.Singleton

/** Optional bridge installed by the Firebase-enabled phone app. No networking in domain. */
@Singleton
class TimerSyncBridge @Inject constructor() {
    var handler: Handler? = null
    val enabled: Boolean get() = handler?.enabled == true

    interface Handler {
        val enabled: Boolean
        suspend fun start(typeId: Long, comment: String): Boolean
        suspend fun stop(typeId: Long, startedAt: Long)
        suspend fun reject(message: String)
    }
}
