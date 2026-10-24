//! 客户端图标图片支持:任选本地图片文件,统一规范化为 64px PNG dataURL。
//! 市面常见格式(jpg/png/gif/webp/bmp/ico/tiff/tga/dds/farbfeld/hdr/exr/qoi/pcx)
//! 由 image crate 解码,前端无需关心源格式;动图取首帧。

use base64::Engine as _;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// 图标统一缩方到 64px:日志行 16~20px 渲染,64px 足够 2x 屏清晰,
/// 同时把 dataURL 尺寸压在几 KB 量级,settings 存储不膨胀
const ICON_SIZE: u32 = 64;

/// 弹出图片选择对话框;取消返回 None。
/// 返回值形如 "data:image/png;base64,....",直接可作为 <img src> 与设置存储值
#[tauri::command]
pub async fn pick_client_icon(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .add_filter(
                "图片(全部支持格式)",
                &[
                    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "tga",
                    "dds", "ff", "farbfeld", "hdr", "exr", "qoi", "svg",
                ],
            )
            .blocking_pick_file();
        let Some(picked) = picked else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(|e| format!("路径无效: {e}"))?;
        let bytes = std::fs::read(&path).map_err(|e| format!("读取图片失败: {e}"))?;
        if bytes.len() > 20 * 1024 * 1024 {
            return Err("图片超过 20MB,请先压缩".into());
        }
        normalize_icon(&bytes).map(Some)
    })
    .await
    .map_err(|e| format!("图标处理任务失败: {e}"))?
}

/// SVG 嗅探:头 1KB 内出现 <svg 标签即认定(SVG 文件可能以 <?xml 声明或注释开头)
fn looks_like_svg(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(1024)];
    String::from_utf8_lossy(head).to_lowercase().contains("<svg")
}

/// 位图 → 64px PNG dataURL;SVG → 原样 base64 透传(矢量任意尺寸不失真)。
/// 位图保持宽高比缩到 64px 盒内(不放大小图),Lanczos3 质量最好;透明通道保留
pub fn normalize_icon(bytes: &[u8]) -> Result<String, String> {
    if looks_like_svg(bytes) {
        // SVG 无法像位图那样缩放压缩,设 64KB 上限(足够绝大多数图标),
        // 与 settings 侧 dataURL 钳制口径一致
        if bytes.len() > 64 * 1024 {
            return Err("SVG 超过 64KB,请精简后重试".into());
        }
        return Ok(format!(
            "data:image/svg+xml;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ));
    }
    // image crate 按内容嗅探格式(guess 兼容无扩展名/扩展名错误的文件)
    let img = image::load_from_memory(bytes).map_err(|e| format!("无法解析图片: {e}"))?;
    let (w, h) = (img.width(), img.height());
    let scaled = if w > ICON_SIZE || h > ICON_SIZE {
        img.resize(ICON_SIZE, ICON_SIZE, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let mut png = std::io::Cursor::new(Vec::new());
    scaled
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| format!("图片重编码失败: {e}"))?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png.get_ref())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_roundtrip_and_downscale() {
        // 200x100 纯色图 → 缩到 64x32 盒内
        let mut buf = std::io::Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(200, 100, image::Rgba([200, 30, 30, 255]))
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        let out = normalize_icon(buf.get_ref()).unwrap();
        assert!(out.starts_with("data:image/png;base64,"));
        let decoded = image::load_from_memory(
            &base64::engine::general_purpose::STANDARD
                .decode(out.trim_start_matches("data:image/png;base64,"))
                .unwrap(),
        )
        .unwrap();
        assert!(decoded.width() <= 64 && decoded.height() <= 64);
        assert_eq!(decoded.height(), 32); // 保持宽高比
    }

    #[test]
    fn small_image_not_upscaled() {
        let mut buf = std::io::Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(16, 16, image::Rgba([0, 255, 0, 255]))
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        let out = normalize_icon(buf.get_ref()).unwrap();
        let decoded = image::load_from_memory(
            &base64::engine::general_purpose::STANDARD
                .decode(out.trim_start_matches("data:image/png;base64,"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(decoded.width(), 16); // 小图不放大
    }

    #[test]
    fn jpeg_decodes() {
        // JPEG(无透明)也要能进同一管线
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            80,
            80,
            image::Rgb([10, 20, 30]),
        ));
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageFormat::Jpeg).unwrap();
        let out = normalize_icon(buf.get_ref()).unwrap();
        assert!(out.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn svg_passthrough() {
        // SVG 矢量原样透传:不解码、不缩放,WebView <img> 直接渲染
        let svg = br##"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#e91e63"/></svg>"##;
        let out = normalize_icon(svg).unwrap();
        assert!(out.starts_with("data:image/svg+xml;base64,"));
        // 内容可无损还原
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(out.trim_start_matches("data:image/svg+xml;base64,"))
            .unwrap();
        assert_eq!(decoded, svg.to_vec());
    }

    #[test]
    fn svg_oversize_rejected() {
        // 超过 64KB 的 SVG 拒绝(防异常膨胀进 settings)
        let big = format!("<svg><!--{}--></svg>", "x".repeat(70 * 1024));
        assert!(normalize_icon(big.as_bytes()).is_err());
    }
}
