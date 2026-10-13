package ai.porthole.shared

import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer

object MachineList {
    private val namePattern = Regex("^[a-z0-9-]{1,32}$")

    /**
     * Desktop origin is verified (SPEC 3). The laptop origin is a **GUESS** (plan G-5): same tailnet suffix as
     * the desktop, taken from the P1 plan's `tailscale status --json` note, not read by this code's author.
     * Ben can rename or remove it in the Machines screen.
     */
    val defaults: List<Machine> = listOf(
        Machine("bendesk-omarchy", "https://bendesk-omarchy.tailafe04c.ts.net"),
        Machine("benacer-omarchy", "https://benacer-omarchy.tailafe04c.ts.net"),
    )

    private fun checkName(name: String): String? =
        if (namePattern.matches(name)) null else "Name must be 1 to 32 characters: a-z, 0-9 and -"

    fun add(list: List<Machine>, name: String, originInput: String): Result<List<Machine>> {
        checkName(name)?.let { return fail(it) }
        val origin = Origins.normalize(originInput)
            ?: return fail("Address must look like https://name.tailnet.ts.net (https, a .ts.net host, no port or path)")
        if (list.any { it.name == name }) return fail("A machine called $name already exists")
        if (list.any { Origins.normalize(it.origin) == origin }) return fail("That address is already in the list")
        return Result.success(list + Machine(name, origin))
    }

    fun rename(list: List<Machine>, oldName: String, newName: String): Result<List<Machine>> {
        if (list.none { it.name == oldName }) return fail("No machine called $oldName")
        checkName(newName)?.let { return fail(it) }
        if (newName != oldName && list.any { it.name == newName }) return fail("A machine called $newName already exists")
        return Result.success(list.map { if (it.name == oldName) it.copy(name = newName) else it })
    }

    fun remove(list: List<Machine>, name: String): List<Machine> =
        if (list.none { it.name == name }) list else list.filter { it.name != name }

    fun encode(list: List<Machine>): String = Wire.json.encodeToString(ListSerializer(Machine.serializer()), list)

    /** The stored list, or [defaults] when the text is not a valid list (garbage, bad names, bad or duplicate origins). */
    fun decode(text: String): List<Machine> {
        val list = try {
            Wire.json.decodeFromString(ListSerializer(Machine.serializer()), text)
        } catch (_: SerializationException) {
            return defaults
        } catch (_: IllegalArgumentException) {
            return defaults
        }
        val valid = list.all { checkName(it.name) == null && Origins.normalize(it.origin) == it.origin } &&
            list.map { it.name }.toSet().size == list.size &&
            list.map { it.origin }.toSet().size == list.size
        return if (valid) list else defaults
    }

    private fun fail(message: String): Result<List<Machine>> = Result.failure(IllegalArgumentException(message))
}
