package ai.porthole.shared

import kotlinx.serialization.Serializable

@Serializable
data class Machine(val name: String, val origin: String)
