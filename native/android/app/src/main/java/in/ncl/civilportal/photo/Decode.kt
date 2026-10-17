package `in`.ncl.civilportal.photo

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap

/**
 * A JPEG as it should be seen. The camera records which way up the phone
 * was held as an EXIF tag rather than turning the pixels, and Android's
 * decoder ignores the tag — a portrait photograph would show on its side.
 * (Browsers apply the tag, so the web portal already shows it upright.)
 * Downsampled to about `maxSide` pixels: a preview needs no more, and a
 * full photograph decoded for a thumbnail wastes memory.
 */
fun decodeUpright(jpeg: ByteArray, maxSide: Int = 1600): ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, bounds)
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
    val bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, BitmapFactory.Options().apply { inSampleSize = sample })
        ?: return null
    val degrees = runCatching {
        when (ExifInterface(jpeg.inputStream()).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90f
            ExifInterface.ORIENTATION_ROTATE_180 -> 180f
            ExifInterface.ORIENTATION_ROTATE_270 -> 270f
            else -> 0f
        }
    }.getOrDefault(0f)
    val upright = if (degrees == 0f) bmp
        else Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(degrees) }, true)
    return upright.asImageBitmap()
}
