package ai.porthole.app

import android.app.Application

class PortholeApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Graph.init(this)
    }
}
