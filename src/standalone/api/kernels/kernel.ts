// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { l10n, CancellationToken, Event, EventEmitter, NotebookCellOutput, type NotebookController } from 'vscode';
import { Kernel, KernelStatus, Output } from '../../../api';
import { ServiceContainer } from '../../../platform/ioc/container';
import { IKernel, IKernelProvider, INotebookKernelExecution } from '../../../kernels/types';
import { IDisposable, IDisposableRegistry } from '../../../platform/common/types';
import { DisposableBase, dispose } from '../../../platform/common/utils/lifecycle';
import { noop } from '../../../platform/common/utils/misc';
import { getTelemetrySafeHashedString } from '../../../platform/telemetry/helpers';
import { Telemetry, sendTelemetryEvent } from '../../../telemetry';
import { StopWatch } from '../../../platform/common/utils/stopWatch';
import { once } from '../../../platform/common/utils/events';
import { logger } from '../../../platform/logging';
import {
    DATA_WRANGLER_EXTENSION_ID,
    JVSC_EXTENSION_ID,
    POWER_TOYS_EXTENSION_ID,
    PROPOSED_API_ALLOWED_PUBLISHERS,
    PYTHON_LANGUAGE
} from '../../../platform/common/constants';
import { ChatMime, generatePythonCodeToInvokeCallback } from '../../../kernels/chat/generator';
import {
    isDisplayIdTrackedForExtension,
    trackDisplayDataForExtension
} from '../../../kernels/execution/extensionDisplayDataTracker';
import { getNotebookCellOutputMetadata } from '../../../kernels/execution/helpers';
import { registerChangeHandler, requestApiAccess } from './apiAccess';
import { IControllerRegistration } from '../../../notebooks/controllers/types';
import { KernelExecutionProgressIndicator } from './kernelProgressIndicator';

/**
 * Error to be throw to to notify calls of the API that access to the API has been revoked by the user.
 */
class KernelAPIAccessRevoked extends Error {
    constructor() {
        super(l10n.t('Access to Jupyter Kernel has been revoked'));
        // WARNING: This name should never be changed as extensions can rely on this.
        // Do not expose as a constant either, at least not yet
        // Lets try this approach for now and see if there can be a better approach.
        // Note: Same approach used in notebook renderer fallbacks.
        this.name = 'vscode.jupyter.apiAccessRevoked';
    }
}

/**
 * Design guidelines for separate kernel per extension.
 * Assume extension A & B use the same kernel and use this API.
 * Both can send code and so can the user via a notebook/iw.
 * Assume user executes code via notebook/iw and that is busy.
 * 1. Extension A executes code `1` against kernel,
 * 2. Laster extension A executes another block of code `2` against the kernel.
 * When executing code `2`, extension A would like to cancel the first request `1`.
 * However the kernel is busy running user code, extension A should not be aware of this knowledge.
 * We should keep track of this, and prevent Extension A from interrupting user code.
 * Once user code is done, then `1` will get picked up by the kernel and when we get an ack back from kernel
 * then we can interrupt the kernel.
 * Similarly, while `2` is busy executing, if Extension B comes in, they have to wait till `2` is done.
 * They have no way of knowing that `2` is busy executing via Extension A (or whether its user code).
 *
 * Basically Extensions should never be allowed to interrupt user code or other extensions code.
 * The Jupyter extension is the only one that can police this.
 *
 * Unfortunately what this means is we need a queue of requests, and the queue should apply to all extensions.
 * This way, when A cancels all requests and it was never sent to the kernel, all we need to do is
 * ensure those requests never get sent to the kernel.
 * While the requests from Extension B that are still in the queue can still get processed even after A cancels all of its requests.
 */
class WrappedKernelPerExtension extends DisposableBase implements Kernel {
    private readonly progress: KernelExecutionProgressIndicator;
    private readonly _api: Kernel;
    public readonly language: string;
    get status(): KernelStatus {
        return this.kernel.status;
    }
    private readonly _onDidChangeStatus = this._register(new EventEmitter<KernelStatus>());
    public get onDidChangeStatus(): Event<KernelStatus> {
        return this._onDidChangeStatus.event;
    }
    private readonly _onDidReceiveDisplayUpdate = this._register(new EventEmitter<NotebookCellOutput>());
    public get onDidReceiveDisplayUpdate(): Event<NotebookCellOutput> {
        return this._onDidReceiveDisplayUpdate.event;
    }
    private accessAllowed?: Promise<boolean>;
    constructor(
        private readonly extensionId: string,
        private readonly kernel: IKernel,
        private readonly execution: INotebookKernelExecution,
        controller?: NotebookController
    ) {
        super();
        this.progress = this._register(new KernelExecutionProgressIndicator(extensionId, kernel, controller));
        this._register(once(kernel.onDisposed)(() => this.progress.dispose()));
        this.language =
            kernel.kernelConnectionMetadata.kind === 'connectToLiveRemoteKernel'
                ? PYTHON_LANGUAGE
                : kernel.kernelConnectionMetadata.kernelSpec.language || PYTHON_LANGUAGE;
        this._register(this.kernel.onStatusChanged(() => this._onDidChangeStatus.fire(this.kernel.status)));
        this._register(
            execution.onDidReceiveDisplayUpdate((output) => {
                const session = this.kernel.session;
                const metadata = getNotebookCellOutputMetadata(output);
                if (
                    metadata?.outputType === 'display_data' &&
                    metadata?.transient?.display_id &&
                    session &&
                    isDisplayIdTrackedForExtension(this.extensionId, session, metadata?.transient?.display_id)
                ) {
                    this._onDidReceiveDisplayUpdate.fire(output);
                }
            })
        );
        // Plain object returned to 3rd party extensions that cannot be modified or messed with.
        const that = this;
        this._api = Object.freeze({
            language: this.language,
            get status() {
                return that.kernel.status;
            },
            onDidChangeStatus: that.onDidChangeStatus.bind(this),
            get onDidReceiveDisplayUpdate() {
                if (
                    ![JVSC_EXTENSION_ID, POWER_TOYS_EXTENSION_ID, DATA_WRANGLER_EXTENSION_ID].includes(extensionId) &&
                    !PROPOSED_API_ALLOWED_PUBLISHERS.includes(extensionId.split('.')[0])
                ) {
                    throw new Error(`Proposed API is not supported for extension ${extensionId}`);
                }

                return that.onDidReceiveDisplayUpdate.bind(this);
            },
            executeCode: (code: string, token: CancellationToken) => this.executeCode(code, token)
        });
    }
    static createApiKernel(
        extensionId: string,
        kernel: IKernel,
        execution: INotebookKernelExecution,
        controller?: NotebookController
    ) {
        const wrapper = new WrappedKernelPerExtension(extensionId, kernel, execution, controller);
        ServiceContainer.instance.get<IDisposableRegistry>(IDisposableRegistry).push(wrapper);
        return { api: wrapper._api, progress: wrapper.progress };
    }

    private async checkAccess() {
        if (this.extensionId === JVSC_EXTENSION_ID) {
            return;
        }
        if (!this.accessAllowed) {
            this.accessAllowed = this.doCheckAccess();
            this._register(registerChangeHandler(() => (this.accessAllowed = undefined)));
        }
        const accessAllowed = await this.accessAllowed;
        if (!accessAllowed) {
            throw new KernelAPIAccessRevoked();
        }
    }

    private async doCheckAccess() {
        // Check and prompt for access only if we know we have a kernel.
        const access = await requestApiAccess(this.extensionId);
        const accessAllowed = access.accessAllowed;
        sendTelemetryEvent(Telemetry.NewJupyterKernelsApiUsage, undefined, {
            extensionId: this.extensionId,
            pemUsed: 'getKernel',
            accessAllowed
        });
        return accessAllowed;
    }

    async *executeCode(code: string, token: CancellationToken): AsyncGenerator<Output, void, unknown> {
        await this.checkAccess();
        for await (const output of this.executeCodeInternal(code, undefined, token)) {
            yield output;
        }
    }

    async *executeCodeInternal(
        code: string,
        handlers: Record<string, (...data: any[]) => Promise<any>> = {},
        token: CancellationToken
    ): AsyncGenerator<Output, void, unknown> {
        let completed = false;
        const measures = {
            executionCount: this.execution.executionCount,
            requestSentAfter: 0,
            requestAcknowledgedAfter: 0,
            cancelledAfter: 0,
            duration: 0
        };
        const properties = {
            kernelId: '',
            extensionId: this.extensionId,
            cancelled: false,
            requestSent: false,
            requestAcknowledged: false,
            cancelledBeforeRequestSent: false,
            cancelledBeforeRequestAcknowledged: false,
            mimeTypes: '',
            failed: false
        };
        const stopwatch = new StopWatch();
        const mimeTypes = new Set<string>();
        sendApiTelemetry(this.extensionId, this.kernel, 'executeCode', measures.executionCount).catch(noop);

        if (this.kernel.disposed) {
            properties.failed = true;
            sendApiExecTelemetry(this.kernel, measures, properties).catch(noop);
            throw new Error('Kernel is disposed');
        }
        if (!this.kernel.session?.kernel) {
            properties.failed = true;
            sendApiExecTelemetry(this.kernel, measures, properties).catch(noop);
            if (this.kernel.status === 'dead' || this.kernel.status === 'terminating') {
                throw new Error('Kernel is dead or terminating');
            }
            throw new Error('Kernel connection not available to execute 3rd party code');
        }

        const disposables: IDisposable[] = [];
        disposables.push({
            dispose: () => {
                measures.duration = stopwatch.elapsedTime;
                properties.mimeTypes = Array.from(mimeTypes).join(',');
                completed = true;
                sendApiExecTelemetry(this.kernel, measures, properties).catch(noop);
            }
        });
        const kernelExecution = ServiceContainer.instance
            .get<IKernelProvider>(IKernelProvider)
            .getKernelExecution(this.kernel);

        const events = {
            started: new EventEmitter<void>(),
            executionAcknowledged: new EventEmitter<void>()
        };

        events.started.event(
            () => {
                properties.requestSent = true;
                measures.requestSentAfter = stopwatch.elapsedTime;
                if (!token.isCancellationRequested && this.extensionId !== JVSC_EXTENSION_ID) {
                    disposables.push(this.progress.show());
                }
            },
            this,
            disposables
        );
        events.executionAcknowledged.event(
            () => {
                properties.requestAcknowledged = true;
                measures.requestAcknowledgedAfter = stopwatch.elapsedTime;
            },
            this,
            disposables
        );

        token.onCancellationRequested(
            () => {
                if (completed) {
                    return;
                }
                properties.cancelled = true;
                measures.cancelledAfter = stopwatch.elapsedTime;
                properties.cancelledBeforeRequestSent = !properties.requestSent;
                properties.cancelledBeforeRequestAcknowledged = !properties.requestAcknowledged;
                logger.debug(`Code execution cancelled by extension ${this.extensionId}`);
            },
            this,
            disposables
        );

        try {
            for await (const output of kernelExecution.executeCode(code, this.extensionId, events, token)) {
                trackDisplayDataForExtension(this.extensionId, this.kernel.session, output);
                output.items.forEach((output) => mimeTypes.add(output.mime));
                if (handlers && hasChatOutput(output)) {
                    for await (const chatOutput of this.handleChatOutput(
                        output,
                        kernelExecution,
                        events,
                        mimeTypes,
                        handlers,
                        token
                    )) {
                        yield chatOutput;
                    }
                } else {
                    yield output;
                }
            }
        } finally {
            dispose(disposables);
        }
    }
    async *handleChatOutput(
        output: NotebookCellOutput,
        kernelExecution: INotebookKernelExecution,
        events: {
            started: EventEmitter<void>;
            executionAcknowledged: EventEmitter<void>;
        },
        mimeTypes: Set<string>,
        handlers: Record<string, (data?: string) => Promise<string | undefined>> = {},
        token: CancellationToken
    ): AsyncGenerator<Output, void, unknown> {
        const chatOutput = output.items.find((i) => i.mime === ChatMime);
        if (!chatOutput) {
            return;
        }
        type Metadata = {
            id: string;
            function: string;
            dataIsNone: boolean;
        };
        const metadata: Metadata = (output.metadata || {})['metadata'];
        const functionId = metadata.function;
        const id = metadata.id;
        const data = metadata.dataIsNone ? undefined : new TextDecoder().decode(chatOutput.data);
        const handler = handlers[functionId];
        if (!handler) {
            throw new Error(`Chat Function ${functionId} not found`);
        }
        const result = await handler(data);

        // Send the result back to the chat window.
        const code = generatePythonCodeToInvokeCallback(id, result);
        for await (const output of kernelExecution.executeCode(code, this.extensionId, events, token)) {
            output.items.forEach((output) => mimeTypes.add(output.mime));
            if (hasChatOutput(output)) {
                for await (const chatOutput of this.handleChatOutput(
                    output,
                    kernelExecution,
                    events,
                    mimeTypes,
                    handlers,
                    token
                )) {
                    yield chatOutput;
                }
            } else {
                yield output;
            }
        }
    }
}

function hasChatOutput(output: NotebookCellOutput) {
    return output.items.some((i) => i.mime === ChatMime);
}

async function sendApiTelemetry(extensionId: string, kernel: IKernel, pemUsed: keyof Kernel, executionCount: number) {
    const kernelId = await getTelemetrySafeHashedString(kernel.id);
    sendTelemetryEvent(Telemetry.NewJupyterKernelApiUsage, { executionCount }, { kernelId, pemUsed, extensionId });
}
async function sendApiExecTelemetry(
    kernel: IKernel,
    measures: {
        executionCount: number;
        requestSentAfter: number;
        requestAcknowledgedAfter: number;
        cancelledAfter: number;
        duration: number;
    },
    properties: {
        kernelId: string;
        extensionId: string;
        requestSent: boolean;
        cancelled: boolean;
        requestAcknowledged: boolean;
        cancelledBeforeRequestSent: boolean;
        cancelledBeforeRequestAcknowledged: boolean;
        mimeTypes: string;
        failed: boolean;
    }
) {
    properties.kernelId = await getTelemetrySafeHashedString(kernel.id);
    sendTelemetryEvent(Telemetry.NewJupyterKernelApiExecution, measures, properties);
}

export function createKernelApiForExtension(extensionId: string, kernel: IKernel) {
    const kernelProvider = ServiceContainer.instance.get<IKernelProvider>(IKernelProvider);
    const controller = ServiceContainer.instance
        .get<IControllerRegistration>(IControllerRegistration)
        .getSelected(kernel.notebook)?.controller;
    return WrappedKernelPerExtension.createApiKernel(
        extensionId,
        kernel,
        kernelProvider.getKernelExecution(kernel),
        controller
    );
}
