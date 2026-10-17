package `in`.ncl.civilportal.auth

import `in`.ncl.civilportal.api.identity.models.TokenResponseAssignmentsInner

/** Plain names for the roles, as the web portal shows them. */
object Roles {
    private val names = mapOf(
        "RESIDENT" to "Resident", "CUSTODIAN" to "Custodian",
        "CONTRACTOR" to "Contractor", "CONTRACTOR_SUPERVISOR" to "Contractor Supervisor",
        "CIVIL_OVERSEER" to "Civil Colony Overseer", "MAINTENANCE_INCHARGE" to "Civil Colony Incharge",
        "STAFF_OFFICER_CIVIL" to "Area Civil Staff Officer", "AREA_HR_ADMIN" to "Area HR Administrator",
        "AREA_SYS_ADMIN" to "Area System Administrator", "GM_CIVIL" to "GM (Civil)",
        "HQ_EXECUTIVE" to "HQ", "ADMINISTRATOR" to "HQ System Administrator")

    fun name(role: String?): String = names[role] ?: (role ?: "")

    /** "My quarter — D-12" for a home, the role and Area otherwise (as on the web). */
    fun label(a: TokenResponseAssignmentsInner): String {
        val role = a.role?.value
        return when (role) {
            "RESIDENT" -> "My quarter — ${a.premises ?: ""}"
            "CUSTODIAN" -> "Building — ${a.premises ?: ""}"
            else -> listOfNotNull(name(role), a.area).joinToString(" · ")
        }
    }

    /** Official roles ask for the PIN or biometric each time they are opened (decision 15). */
    fun needsUnlock(a: TokenResponseAssignmentsInner): Boolean =
        a.accountable ?: (a.role?.value !in setOf("RESIDENT", "CUSTODIAN", "CONTRACTOR"))
}
