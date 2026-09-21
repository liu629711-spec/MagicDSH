/**
 * 图片尺寸嗅探（docx 嵌入需要显式宽高，蓝本 python-docx 只给宽度、高按原始比例自动缩放）。
 *
 * 只识别 docx 包支持的四种位图格式：PNG / JPEG / GIF / BMP。识别失败返回 null，
 * 调用方按蓝本口径发「图片无法嵌入」警告并渲染 [图片损坏：…] 占位。
 */
export type ImageFormat = 'png' | 'jpg' | 'gif' | 'bmp';
export interface SniffedImage {
    type: ImageFormat;
    width: number;
    height: number;
}
export declare function sniffImage(bytes: Uint8Array): SniffedImage | null;
//# sourceMappingURL=image-size.d.ts.map