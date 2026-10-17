package `in`.ncl.civilportal.security

import java.util.Base64

/**
 * The two encodings the device key meets on its way to the server.
 *
 * Android's Keystore signs ECDSA in DER (a SEQUENCE of two INTEGERs); the
 * portal verifies the raw r‖s form, 32 bytes each for P-256 (Node's
 * `dsaEncoding: 'ieee-p1363'`). And the public key goes to the server as
 * PEM, exactly as stored at registration: the server compares the two
 * strings, so the app must send the same text every time.
 *
 * Plain Kotlin, no Android, so the JVM tests exercise it against a real
 * verifier.
 */
object Ecdsa {
    private const val COORD = 32   // P-256

    /** DER `SEQUENCE { INTEGER r, INTEGER s }` → r‖s, each left-padded to 32 bytes. */
    fun derToP1363(der: ByteArray): ByteArray {
        var i = 0
        require(der[i++] == 0x30.toByte()) { "not a DER sequence" }
        i += lengthBytes(der, i).second
        val (r, afterR) = readInteger(der, i)
        val (s, _) = readInteger(der, afterR)
        return fixed(r) + fixed(s)
    }

    /** SubjectPublicKeyInfo (X.509 encoded) → PEM text with 64-character lines. */
    fun publicKeyPem(spki: ByteArray): String {
        val b64 = Base64.getEncoder().encodeToString(spki)
        return buildString {
            append("-----BEGIN PUBLIC KEY-----\n")
            b64.chunked(64).forEach { append(it).append('\n') }
            append("-----END PUBLIC KEY-----\n")
        }
    }

    private fun readInteger(der: ByteArray, at: Int): Pair<ByteArray, Int> {
        var i = at
        require(der[i++] == 0x02.toByte()) { "not a DER integer" }
        val (len, used) = lengthBytes(der, i)
        i += used
        return der.copyOfRange(i, i + len) to i + len
    }

    /** (length, bytes used to encode it); short and long forms */
    private fun lengthBytes(der: ByteArray, at: Int): Pair<Int, Int> {
        val first = der[at].toInt() and 0xff
        if (first < 0x80) return first to 1
        val n = first and 0x7f
        var len = 0
        for (k in 1..n) len = (len shl 8) or (der[at + k].toInt() and 0xff)
        return len to 1 + n
    }

    /** strip DER's sign padding, left-pad to the coordinate size */
    private fun fixed(v: ByteArray): ByteArray {
        val trimmed = v.dropWhile { it == 0.toByte() }.toByteArray()
        require(trimmed.size <= COORD) { "integer too long for P-256" }
        return ByteArray(COORD - trimmed.size) + trimmed
    }
}
