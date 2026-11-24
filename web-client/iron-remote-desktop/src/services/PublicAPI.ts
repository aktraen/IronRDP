import { loggingService } from './logging.service';
import type { NewSessionInfo } from '../interfaces/NewSessionInfo';
import { SpecialCombination } from '../enums/SpecialCombination';
import { RemoteDesktopService } from './remote-desktop.service';
import type { UserInteraction } from '../interfaces/UserInteraction';
import type { ScreenScale } from '../enums/ScreenScale';
import { ConfigBuilder } from './ConfigBuilder';
import { Config } from './Config';
import type { Extension } from '../interfaces/Extension';
import type { ClipboardService } from './clipboard.service';
import type { FileTransferProvider } from '../interfaces/FileTransferProvider';

export class PublicAPI {
    private remoteDesktopService: RemoteDesktopService;
    private clipboardService: ClipboardService;

    constructor(remoteDesktopService: RemoteDesktopService, clipboardService: ClipboardService) {
        this.remoteDesktopService = remoteDesktopService;
        this.clipboardService = clipboardService;
    }

    private configBuilder(): ConfigBuilder {
        return this.remoteDesktopService.configBuilder();
    }

    private connect(config: Config): Promise<NewSessionInfo> {
        loggingService.info('Initializing connection.');
        return this.remoteDesktopService.connect(config);
    }

    private ctrlAltDel() {
        this.remoteDesktopService.sendSpecialCombination(SpecialCombination.CTRL_ALT_DEL);
    }

    private metaKey() {
        this.remoteDesktopService.sendSpecialCombination(SpecialCombination.META);
    }

    private ctrlC() {
        this.remoteDesktopService.sendSpecialCombination(SpecialCombination.CTRL_C);
    }

    private ctrlV() {
        this.remoteDesktopService.sendSpecialCombination(SpecialCombination.CTRL_V);
    }

    private setVisibility(state: boolean) {
        loggingService.info(`Change component visibility to: ${state}`);
        this.remoteDesktopService.setVisibility(state);
    }

    private setScale(scale: ScreenScale) {
        this.remoteDesktopService.setScale(scale);
    }

    private shutdown() {
        this.remoteDesktopService.shutdown();
    }

    private setKeyboardUnicodeMode(use_unicode: boolean) {
        this.remoteDesktopService.setKeyboardUnicodeMode(use_unicode);
    }

    private setCursorStyleOverride(style: string | null) {
        this.remoteDesktopService.setCursorStyleOverride(style);
    }

    private resize(width: number, height: number, scale?: number) {
        this.remoteDesktopService.resizeDynamic(width, height, scale);
    }

    private setEnableClipboard(enable: boolean) {
        this.remoteDesktopService.setEnableClipboard(enable);
    }

    private setEnableAutoClipboard(enable: boolean) {
        this.remoteDesktopService.setEnableAutoClipboard(enable);
    }

    private setOnWarningCallback(callback: (data: string) => void) {
        this.remoteDesktopService.setOnWarningCallback(callback);
    }

    private setOnClipboardRemoteUpdateCallback(callback: () => void) {
        this.remoteDesktopService.setOnClipboardRemoteUpdate(callback);
    }

    private async saveRemoteClipboardData(): Promise<void> {
        return await this.clipboardService.saveRemoteClipboardData();
    }

    private async sendClipboardData(): Promise<void> {
        return await this.clipboardService.sendClipboardData();
    }

    private async pasteClipboardText(text: string): Promise<void> {
        return await this.clipboardService.pasteText(text);
    }

    private invokeExtension(ext: Extension): unknown {
        return this.remoteDesktopService.invokeExtension(ext);
    }

    private enableFileTransfer(provider: FileTransferProvider): FileTransferProvider {
        // Wire clipboard monitoring suppression so the polling loop does not
        // clobber a file upload's FormatList with a text/image clipboard update.
        const origStart = provider.onUploadStarted;
        const origFinish = provider.onUploadFinished;
        provider.onUploadStarted = () => {
            origStart?.();
            this.clipboardService.suppressMonitoring();
        };
        provider.onUploadFinished = () => {
            this.clipboardService.resumeMonitoring();
            origFinish?.();
        };
        return this.remoteDesktopService.enableFileTransfer(provider);
    }

    private sendPointerMove(x: number, y: number) {
        this.remoteDesktopService.sendPointerMove(x, y);
    }

    private sendPointerButton(button: number, pressed: boolean) {
        this.remoteDesktopService.sendPointerButton(button, pressed);
    }

    private sendWheel(event: WheelEvent) {
        this.remoteDesktopService.sendWheel(event);
    }

    private sendKeyboardEvent(event: KeyboardEvent) {
        if (this.remoteDesktopService.session == null) return;
        this.remoteDesktopService.sendKeyboardEvent(event);
    }

    private syncInputState(event: MouseEvent | KeyboardEvent) {
        this.remoteDesktopService.syncInputState(event);
    }

    private releaseAllInputs() {
        this.remoteDesktopService.releaseAllInputs();
    }

    private setOnCursorStyleCallback(callback: (cursor: string) => void) {
        this.remoteDesktopService.setOnCursorStyle(callback);
    }

    private renderCanvas(): HTMLCanvasElement | undefined {
        return this.remoteDesktopService.renderCanvas();
    }

    getExposedFunctions(): UserInteraction {
        return {
            setVisibility: this.setVisibility.bind(this),
            configBuilder: this.configBuilder.bind(this),
            connect: this.connect.bind(this),
            onWarningCallback: this.setOnWarningCallback.bind(this),
            onClipboardRemoteUpdateCallback: this.setOnClipboardRemoteUpdateCallback.bind(this),
            setScale: this.setScale.bind(this),
            ctrlAltDel: this.ctrlAltDel.bind(this),
            metaKey: this.metaKey.bind(this),
            ctrlC: this.ctrlC.bind(this),
            ctrlV: this.ctrlV.bind(this),
            shutdown: this.shutdown.bind(this),
            setKeyboardUnicodeMode: this.setKeyboardUnicodeMode.bind(this),
            setCursorStyleOverride: this.setCursorStyleOverride.bind(this),
            resize: this.resize.bind(this),
            setEnableClipboard: this.setEnableClipboard.bind(this),
            setEnableAutoClipboard: this.setEnableAutoClipboard.bind(this),
            saveRemoteClipboardData: this.saveRemoteClipboardData.bind(this),
            sendClipboardData: this.sendClipboardData.bind(this),
            pasteClipboardText: this.pasteClipboardText.bind(this),
            invokeExtension: this.invokeExtension.bind(this),
            enableFileTransfer: this.enableFileTransfer.bind(this),
            sendPointerMove: this.sendPointerMove.bind(this),
            sendPointerButton: this.sendPointerButton.bind(this),
            sendWheel: this.sendWheel.bind(this),
            sendKeyboardEvent: this.sendKeyboardEvent.bind(this),
            syncInputState: this.syncInputState.bind(this),
            releaseAllInputs: this.releaseAllInputs.bind(this),
            onCursorStyleCallback: this.setOnCursorStyleCallback.bind(this),
            renderCanvas: this.renderCanvas.bind(this),
        };
    }
}
