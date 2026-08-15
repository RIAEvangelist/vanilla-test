import fs from 'node:fs/promises';
import path from 'node:path';

const MARKER_NAME = '.vanilla-test-coverage.json';
const MARKER_SCHEMA_VERSION = 1;

function ownershipError(directory) {
    const error = new Error(
        `Refusing to replace unowned coverage directory: ${directory}. `
        + 'Move or remove it, then rerun vanilla-test so the directory can be created safely.'
    );
    error.code = 'ERR_VANILLA_TEST_UNOWNED_OUTPUT';
    return error;
}

function marker(runtime) {
    return {
        schemaVersion: MARKER_SCHEMA_VERSION,
        owner: 'vanilla-test',
        runtime
    };
}

async function validMarker(directory, runtime) {
    const markerPath = path.join(directory, MARKER_NAME);
    const metadata = await fs.lstat(markerPath).catch(() => null);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) return false;

    try {
        const value = JSON.parse(await fs.readFile(markerPath, 'utf8'));
        return value?.schemaVersion === MARKER_SCHEMA_VERSION
            && value?.owner === 'vanilla-test'
            && value?.runtime === runtime;
    } catch {
        return false;
    }
}

async function validateOwnedDirectory(directory, runtime) {
    const metadata = await fs.lstat(directory).catch(() => null);
    if (!metadata) return false;
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !await validMarker(directory, runtime)) {
        throw ownershipError(directory);
    }
    return true;
}

async function writeOutputMarker(directory, runtime) {
    await fs.writeFile(
        path.join(directory, MARKER_NAME),
        `${JSON.stringify(marker(runtime), null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    );
}

export async function createOutputTransaction(directory, runtime) {
    const parent = path.dirname(directory);
    await fs.mkdir(parent, { recursive: true });
    await validateOwnedDirectory(directory, runtime);

    const stagingDirectory = await fs.mkdtemp(path.join(parent, `.vanilla-test-${runtime}-`));
    let committed = false;

    return {
        directory: stagingDirectory,
        async commit() {
            if (committed) throw new Error(`Coverage output transaction is already committed: ${directory}`);
            await writeOutputMarker(stagingDirectory, runtime);

            const ownedExisting = await validateOwnedDirectory(directory, runtime);
            const backupDirectory = path.join(
                parent,
                `.vanilla-test-${runtime}-backup-${process.pid}-${Date.now()}`
            );

            if (ownedExisting) await fs.rename(directory, backupDirectory);
            try {
                await fs.rename(stagingDirectory, directory);
                committed = true;
            } catch (error) {
                if (ownedExisting) await fs.rename(backupDirectory, directory).catch(() => {});
                throw error;
            }
            if (ownedExisting) await fs.rm(backupDirectory, { recursive: true, force: true }).catch(() => {});
        },
        async cleanup() {
            if (!committed) await fs.rm(stagingDirectory, { recursive: true, force: true });
        }
    };
}

export {
    MARKER_NAME,
    MARKER_SCHEMA_VERSION,
    ownershipError,
    validMarker
};
