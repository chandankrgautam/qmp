package `in`.ncl.civilportal.auth

import `in`.ncl.civilportal.api.identity.models.AuthChallengePostRequest
import `in`.ncl.civilportal.api.identity.models.AuthOtpRequestPostRequest
import `in`.ncl.civilportal.api.identity.models.AuthOtpVerifyPostRequest
import `in`.ncl.civilportal.api.identity.models.AuthSelectRolePostRequest
import `in`.ncl.civilportal.api.identity.models.AuthSwitchRolePostRequest
import `in`.ncl.civilportal.api.identity.models.AuthTokenPostRequest
import `in`.ncl.civilportal.api.identity.models.HomeRequest
import `in`.ncl.civilportal.api.identity.models.MastersBuildingsGet200ResponseInner
import `in`.ncl.civilportal.api.identity.models.MeHomesPostRequest
import `in`.ncl.civilportal.api.identity.models.MastersColoniesGet200ResponseInner
import `in`.ncl.civilportal.api.identity.models.Registration
import `in`.ncl.civilportal.api.identity.models.RegistrationRequest
import `in`.ncl.civilportal.api.identity.models.TokenResponse
import `in`.ncl.civilportal.net.Portal
import `in`.ncl.civilportal.net.PortalError
import `in`.ncl.civilportal.net.ok
import `in`.ncl.civilportal.net.Session
import `in`.ncl.civilportal.security.DeviceKey
import java.util.UUID

/**
 * Registering this phone and signing in with it.
 *
 * Signing in proves the phone holds its key: the server sends a one-time
 * challenge, the Keystore signs it, the server checks the signature with the
 * public key recorded at registration. Then a role is chosen (decision
 * 2026-09-30); an official role is opened only after the PIN or biometric.
 */
class AuthRepository(private val portal: Portal, private val key: DeviceKey, private val session: Session) {

    /* ---------------- registration */
    suspend fun colonies(): List<MastersColoniesGet200ResponseInner> = ok(portal.masters.mastersColoniesGet())
    suspend fun buildings(colony: UUID): List<MastersBuildingsGet200ResponseInner> = ok(portal.masters.mastersBuildingsGet(colony))

    /** Returns the development code when the server shows it (no SMS gateway yet). */
    suspend fun requestOtp(mobile: String): String? = ok(portal.auth.authOtpRequestPost(AuthOtpRequestPostRequest(mobile = mobile))).devCode

    suspend fun verifyOtp(mobile: String, code: String): String =
        ok(portal.auth.authOtpVerifyPost(AuthOtpVerifyPostRequest(mobile = mobile, code = code))).registrationToken
            ?: throw PortalError("The code could not be verified", 422)

    suspend fun register(registrationToken: String, request: (publicKey: String) -> RegistrationRequest): Registration {
        key.ensure()
        return ok(portal.registration.registrationsPost(registrationToken, request(key.publicKeyPem())))
    }

    /* ---------------- signing in */
    val registeredKey: Boolean get() = key.exists

    /** Prove the phone; returns a token (one role) or a person token and the roles to choose from. */
    suspend fun signIn(assignmentId: UUID? = null, secondFactor: Boolean = false): TokenResponse {
        val pem = key.publicKeyPem()
        val nonce = ok(portal.auth.authChallengePost(AuthChallengePostRequest(publicKey = pem))).nonce
            ?: throw PortalError("The portal did not send a challenge", 500)
        val t = ok(portal.auth.authTokenPost(AuthTokenPostRequest(
            publicKey = pem, nonce = nonce, signature = key.sign(nonce),
            secondFactorSatisfied = secondFactor, assignmentId = assignmentId)))
        if (t.token != null) session.signedIn(t)
        return t
    }

    suspend fun selectRole(personToken: String, assignmentId: UUID, secondFactor: Boolean): TokenResponse {
        val t = ok(portal.auth.authSelectRolePost(AuthSelectRolePostRequest(
            personToken = personToken, assignmentId = assignmentId, secondFactorSatisfied = secondFactor)))
        session.signedIn(t)
        return t
    }

    suspend fun switchRole(assignmentId: UUID, secondFactor: Boolean): TokenResponse {
        val t = ok(portal.auth.authSwitchRolePost(AuthSwitchRolePostRequest(
            assignmentId = assignmentId, secondFactorSatisfied = secondFactor)))
        session.signedIn(t)
        return t
    }

    /* ---------------- homes added by someone already signed in (2026-10-13) */
    suspend fun myHomes(): List<HomeRequest> = ok(portal.registration.meHomesGet()).items.orEmpty()

    suspend fun addHome(colony: UUID, custodian: Boolean, identifier: String, noSector: Boolean): HomeRequest =
        ok(portal.registration.meHomesPost(MeHomesPostRequest(colonyId = colony, identifier = identifier, noSector = noSector,
            role = if (custodian) MeHomesPostRequest.Role.CUSTODIAN else MeHomesPostRequest.Role.RESIDENT)))

    fun signOut() = session.signedOut()
}
