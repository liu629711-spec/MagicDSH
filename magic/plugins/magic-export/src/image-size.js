/**
 * 图片尺寸嗅探（docx 嵌入需要显式宽高，蓝本 python-docx 只给宽度、高按原始比例自动缩放）。
 *
 * 只识别 docx 包支持的四种位图格式：PNG / JPEG / GIF / BMP。识别失败返回 null，
 * 调用方按蓝本口径发「图片无法嵌入」警告并渲染 [图片损坏：…] 占位。
 */
export function sniffImage(bytes) {
    if (bytes.length < 8)
        return null;
    // PNG: 8 字节签名 + IHDR（宽高在固定偏移，大端）。
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
        if (bytes.length < 24)
            return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return { type: 'png', width: view.getUint32(16), height: view.getUint32(20) };
    }
    // GIF: 'GIF8'，宽高在 6/8（小端）。
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        if (bytes.length < 10)
            return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return { type: 'gif', width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    // BMP: 'BM'，宽高在 18/22（小端有符号，高度可为负=上下翻转）。
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
        if (bytes.length < 26)
            return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const height = Math.abs(view.getInt32(22, true));
        return { type: 'bmp', width: Math.abs(view.getInt32(18, true)), height };
    }
    // JPEG: FF D8 FF，逐段扫描找 SOFn 段取宽高。
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let i = 2;
        while (i + 9 < bytes.length) {
            if (bytes[i] !== 0xff) {
                i += 1;
                continue;
            }
            const marker = bytes[i + 1];
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                i += 2;
                continue;
            }
            if (bytes.length < i + 4)
                return null;
            const segLen = view.getUint16(i + 2);
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                if (bytes.length < i + 9)
                    return null;
                const height = view.getUint16(i + 5);
                const width = view.getUint16(i + 7);
                if (width === 0 || height === 0)
                    return null;
                return { type: 'jpg', width, height };
            }
            i += 2 + segLen;
        }
        return null;
    }
    return null;
}
//# sourceMappingURL=image-size.js.map