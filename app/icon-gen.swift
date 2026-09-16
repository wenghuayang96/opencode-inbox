import AppKit

// 生成 OC收件箱 应用图标（深色圆角底 + 白色托盘 + 橙色未读点），输出标准 iconset
// 用法: swift icon-gen.swift <iconset输出目录>

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write("usage: swift icon-gen.swift <iconset-dir>\n".data(using: .utf8)!)
    exit(64)
}
let outDir = URL(fileURLWithPath: CommandLine.arguments[1])

let entries: [(String, Int)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]

func draw(_ ctx: CGContext, px: CGFloat) {
    // 位图上下文坐标系可能是 top-down，先统一为 AppKit 的 y 向上
    if NSGraphicsContext.current?.isFlipped == true {
        ctx.translateBy(x: 0, y: px)
        ctx.scaleBy(x: 1, y: -1)
    }
    let box = CGRect(x: px * 0.098, y: px * 0.098, width: px * 0.804, height: px * 0.804)
    let radius = box.width * 0.2237

    ctx.saveGState()
    ctx.addPath(CGPath(roundedRect: box, cornerWidth: radius, cornerHeight: radius, transform: nil))
    ctx.clip()
    let gradient = CGGradient(
        colorsSpace: CGColorSpaceCreateDeviceRGB(),
        colors: [CGColor(red: 0.17, green: 0.19, blue: 0.25, alpha: 1),
                 CGColor(red: 0.05, green: 0.06, blue: 0.10, alpha: 1)] as CFArray,
        locations: [0, 1]
    )
    if let gradient {
        ctx.drawLinearGradient(gradient,
                               start: CGPoint(x: box.midX, y: box.maxY),
                               end: CGPoint(x: box.midX, y: box.minY),
                               options: [])
    }
    ctx.restoreGState()

    let config = NSImage.SymbolConfiguration(pointSize: px * 0.5, weight: .medium)
    if let base = NSImage(systemSymbolName: "tray.full.fill", accessibilityDescription: nil),
       let symbol = base.withSymbolConfiguration(config) {
        var proposed = NSRect(origin: .zero, size: symbol.size)
        if let mask = symbol.cgImage(forProposedRect: &proposed, context: nil, hints: nil) {
            let glyph = symbol.size
            let scale = box.width * 0.62 / max(glyph.width, glyph.height)
            let size = CGSize(width: glyph.width * scale, height: glyph.height * scale)
            let rect = CGRect(x: box.midX - size.width / 2,
                              y: box.midY - size.height / 2 - px * 0.015,
                              width: size.width, height: size.height)
            ctx.saveGState()
            ctx.translateBy(x: rect.minX, y: rect.minY)
            ctx.scaleBy(x: 1, y: -1)
            ctx.translateBy(x: 0, y: -rect.height)
            ctx.clip(to: CGRect(origin: .zero, size: rect.size), mask: mask)
            ctx.setFillColor(CGColor(red: 0.93, green: 0.95, blue: 0.97, alpha: 1))
            ctx.fill(CGRect(origin: .zero, size: rect.size))
            ctx.restoreGState()
        }
    }

    let dotR = px * 0.082
    let center = CGPoint(x: box.midX + box.width * 0.27, y: box.midY + box.height * 0.27)
    ctx.setLineWidth(px * 0.018)
    ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.9))
    ctx.strokeEllipse(in: CGRect(x: center.x - dotR * 1.2, y: center.y - dotR * 1.2,
                                 width: dotR * 2.4, height: dotR * 2.4))
    ctx.setFillColor(CGColor(red: 1.0, green: 0.58, blue: 0.02, alpha: 1))
    ctx.fillEllipse(in: CGRect(x: center.x - dotR, y: center.y - dotR, width: dotR * 2, height: dotR * 2))
}

for (name, px) in entries {
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ) else {
        FileHandle.standardError.write("bitmap alloc failed\n".data(using: .utf8)!)
        exit(1)
    }
    rep.size = NSSize(width: px, height: px)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    if let ctx = NSGraphicsContext.current?.cgContext {
        draw(ctx, px: CGFloat(px))
    }
    NSGraphicsContext.restoreGraphicsState()
    guard let data = rep.representation(using: .png, properties: [:]) else {
        FileHandle.standardError.write("png encode failed: \(name)\n".data(using: .utf8)!)
        exit(1)
    }
    do {
        try data.write(to: outDir.appendingPathComponent(name))
    } catch {
        FileHandle.standardError.write("write failed \(name): \(error)\n".data(using: .utf8)!)
        exit(1)
    }
}
print("iconset written to \(outDir.path)")
