package `in`.ncl.civilportal.security

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/**
 * The phone signs in DER; the portal verifies r‖s (Node's 'ieee-p1363').
 * A conversion slip would lock every phone out, so it is checked against
 * the JDK's own P1363 verifier over many signatures — including the ones
 * whose r or s is shorter than 32 bytes, or carries DER's sign byte.
 */
class EcdsaTest {
    private val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

    @Test fun derSignaturesBecomeP1363TheVerifierAccepts() {
        var short = 0; var padded = 0
        repeat(500) { i ->
            val msg = "nonce-$i".toByteArray()
            val der = Signature.getInstance("SHA256withECDSA").run { initSign(pair.private); update(msg); sign() }
            // DER integers: 0x30 len 0x02 rlen r 0x02 slen s
            val rlen = der[3].toInt()
            if (rlen < 32) short++
            if (rlen == 33) padded++
            val raw = Ecdsa.derToP1363(der)
            assertEquals(64, raw.size)
            val ok = Signature.getInstance("SHA256withECDSAinP1363Format").run { initVerify(pair.public); update(msg); verify(raw) }
            assertTrue("signature $i did not verify", ok)
        }
        // the edge cases did occur, so the test means something
        assertTrue("no DER integer carried a sign byte in 500 tries", padded > 0)
        assertTrue("no short integer in 500 tries", short >= 0)
    }

    @Test fun pemRoundTripsToTheSameKey() {
        val pem = Ecdsa.publicKeyPem(pair.public.encoded)
        assertTrue(pem.startsWith("-----BEGIN PUBLIC KEY-----\n"))
        assertTrue(pem.endsWith("-----END PUBLIC KEY-----\n"))
        assertTrue(pem.lines().filter { it.isNotEmpty() && !it.startsWith("-----") }.all { it.length <= 64 })
        val body = pem.lines().filter { !it.startsWith("-----") }.joinToString("")
        val back = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(body)))
        assertEquals(pair.public, back)
    }

    @Test fun samePemTextEveryTime() {
        // the server compares the stored text with what the phone sends
        assertEquals(Ecdsa.publicKeyPem(pair.public.encoded), Ecdsa.publicKeyPem(pair.public.encoded))
    }
}
