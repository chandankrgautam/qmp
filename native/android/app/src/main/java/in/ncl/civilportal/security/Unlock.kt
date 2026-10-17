package `in`.ncl.civilportal.security

import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * The second factor for official roles (decision 15): the phone's own
 * fingerprint, face or screen lock, asked each time an official role is
 * opened. Residents are not asked.
 *
 * The server is told the unlock happened (second_factor_satisfied); it
 * cannot check that itself yet — key attestation (phase A5) will.
 */
object Unlock {
    suspend fun ask(activity: FragmentActivity, title: String, subtitle: String): Boolean =
        suspendCancellableCoroutine { cont ->
            val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        if (cont.isActive) cont.resume(true)
                    }
                    override fun onAuthenticationError(code: Int, msg: CharSequence) {
                        if (cont.isActive) cont.resume(false)
                    }
                })
            prompt.authenticate(BiometricPrompt.PromptInfo.Builder()
                .setTitle(title).setSubtitle(subtitle)
                .setAllowedAuthenticators(BIOMETRIC_WEAK or DEVICE_CREDENTIAL)
                .build())
            cont.invokeOnCancellation { prompt.cancelAuthentication() }
        }
}
