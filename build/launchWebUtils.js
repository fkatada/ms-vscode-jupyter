// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const path = require('path');
const fs = require('fs-extra');
const test_web = require('@vscode/test-web');
const { startJupyter } = require('./preLaunchWebTest');
const jsonc = require('jsonc-parser');
const { startReportServer } = require('./webTestReporter');
const { noop } = require('../out/test/core');
const { isCI } = require('./constants');
const extensionDevelopmentPath = path.resolve(__dirname, '../');
const packageJsonFile = path.join(extensionDevelopmentPath, 'package.json');

const browserType =
    process.argv
        .filter((arg) => arg.startsWith('--browser'))
        .map((arg) => arg.split('=')[1])
        .pop() || 'chromium';
const port =
    process.argv
        .filter((arg) => arg.startsWith('--port'))
        .map((arg) => parseInt(arg.split('=')[1]))
        .pop() || 3000;
const attachArgName = '--waitForDebugger=';
const waitForDebuggerArg = process.argv.find((arg) => arg.startsWith(attachArgName));

exports.launch = async function launch(launchTests) {
    let exitCode = 0;
    let server;
    let testServer;
    try {
        if (launchTests) {
            server = (await startJupyter()).server;
            testServer = await startReportServer();
        }
        const bundlePath = path.join(extensionDevelopmentPath, launchTests ? 'out' : 'dist', 'extension.web.bundle.js');

        // Changing the logging level to be read from workspace settings file.
        // This way we can enable verbose logging and get the logs for web tests.
        // Changing the logging level to be read from workspace settings file.
        // This way we can enable verbose logging and get the logs for web tests.
        let settingsJson = fs.readFileSync(packageJsonFile).toString();
        settingsJson = jsonc.applyEdits(
            settingsJson,
            jsonc.modify(
                settingsJson,
                ['contributes', 'configuration', 'properties', 'jupyter.logging.level', 'scope'],
                'resource',
                {}
            )
        );
        // Tests scripts are in the 'out' folder.
        if (launchTests) {
            settingsJson = jsonc.applyEdits(
                settingsJson,
                jsonc.modify(settingsJson, ['main'], './out/extension.node.js', {})
            );
            settingsJson = jsonc.applyEdits(
                settingsJson,
                jsonc.modify(settingsJson, ['browser'], './out/extension.web.bundle.js', {})
            );
        }
        fs.writeFileSync(packageJsonFile, settingsJson);
        const waitForDebugger = waitForDebuggerArg ? Number(waitForDebuggerArg.slice(attachArgName.length)) : undefined;
        const options = {
            browserType,
            verbose: true,
            port,
            headless: isCI ? false : false, // Set this to false to debug failures (false on CI to support capturing screenshots when tests fail).
            extensionDevelopmentPath,
            folderPath: path.resolve(__dirname, '..', 'src', 'test', 'datascience'),
            waitForDebugger
        };
        if (launchTests) {
            options.extensionTestsPath = bundlePath;
        }
        await test_web.runTests(options);
    } catch (err) {
        console.error(launchTests ? 'Failed to run tests' : 'Failed to launch VS Code', err);
        exitCode = 1;
    } finally {
        if (testServer) {
            await testServer.dispose().catch(noop);
        }
        if (server) {
            await server.dispose();
        }
    }

    // Not all promises complete. Force exit
    process.exit(exitCode);
};
