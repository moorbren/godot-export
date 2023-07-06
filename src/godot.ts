import { exec, ExecOptions } from '@actions/exec';
import * as core from '@actions/core';
import { isFeatureAvailable, restoreCache, saveCache } from '@actions/cache';
import * as io from '@actions/io';
import * as path from 'path';
import * as fs from 'fs';
import * as ini from 'ini';
import { ExportPresets, ExportPreset, BuildResult } from './types/GodotExport';
import sanitize from 'sanitize-filename';
import {
  GODOT_CONFIG_PATH,
  GODOT_DOWNLOAD_URL,
  GODOT_TEMPLATES_DOWNLOAD_URL,
  GODOT_WORKING_PATH,
  RELATIVE_PROJECT_PATH,
  WINE_PATH,
  EXPORT_DEBUG,
  PRESETS_TO_EXPORT,
  GODOT_VERBOSE,
  GODOT_BUILD_PATH,
  GODOT_PROJECT_FILE_PATH,
  EXPORT_PACK_ONLY,
  USE_GODOT_3,
  GODOT_EXPORT_TEMPLATES_PATH,
  CACHE_ACTIVE,
  ANDROID_SDK_PATH,
  GODOT_PROJECT_PATH,
} from './constants';

const GODOT_EXECUTABLE = 'godot_executable';
const GODOT_ZIP = 'godot.zip';
const GODOT_TEMPLATES_FILENAME = 'godot_templates.tpz';
const EDITOR_SETTINGS_FILENAME = USE_GODOT_3 ? 'editor_settings-3.tres' : 'editor_settings-4.tres';

const GODOT_TEMPLATES_PATH = path.join(GODOT_WORKING_PATH, 'templates');

let godotExecutablePath: string;

async function exportBuilds(): Promise<BuildResult[]> {
  if (!hasExportPresets()) {
    core.setFailed(
      'No export_presets.cfg found. Please ensure you have defined at least one export via the Godot editor.',
    );
    return [];
  }

  core.startGroup('🕹️ Downloading Godot');
  await downloadGodot();
  core.endGroup();

  core.startGroup('🔍 Adding Editor Settings');
  await addEditorSettings();
  core.endGroup();

  if (WINE_PATH) {
    configureWindowsExport();
  }

  configureAndroidExport();

  if (!USE_GODOT_3) {
    await importProject();
  }

  const results = await doExport();
  core.endGroup();

  return results;
}

function hasExportPresets(): boolean {
  try {
    const projectPath = path.resolve(RELATIVE_PROJECT_PATH);
    return fs.statSync(path.join(projectPath, 'export_presets.cfg')).isFile();
  } catch (e) {
    return false;
  }
}

async function downloadGodot(): Promise<void> {
  await setupWorkingPath();

  // if our templates don't exist, we want to download them at the same time as the executable
  const downloadPromises = [downloadExecutable()];

  const templatesStatus = await checkTemplatesStatus();
  if (templatesStatus !== 'up-to-date') {
    core.info(`Godot templates status: ${templatesStatus}`);
    downloadPromises.push(downloadTemplates());
  }

  await Promise.all(downloadPromises);
  await prepareExecutable();

  // if templates are up-to-date, we have nothing to do here
  if (templatesStatus === 'up-to-date') return;

  // the extract step will fail if the templates folder already exists
  if (templatesStatus === 'outdated' || templatesStatus === 'unknown') {
    try {
      fs.unlinkSync(path.join(GODOT_WORKING_PATH, GODOT_TEMPLATES_PATH));
    } catch (e) {
      core.error(`Failed to remove old templates: ${e}`);
    }
  }

  if (USE_GODOT_3) {
    await prepareTemplates3();
  } else {
    await prepareTemplates();
  }
}

async function setupWorkingPath(): Promise<void> {
  await io.mkdirP(GODOT_WORKING_PATH);
  core.info(`Working path created ${GODOT_WORKING_PATH}`);
}

async function downloadFile(
  filePath: string,
  downloadUrl: string,
  cacheKey: string,
  restoreKey: string,
): Promise<void> {
  if (CACHE_ACTIVE && isCacheFeatureAvailable()) {
    const cacheHit = await restoreCache([filePath], cacheKey, [restoreKey]);
    if (cacheHit) {
      core.info(`Restored cached file from ${cacheHit}`);
      return;
    }
  }
  core.info(`Downloading file from ${downloadUrl}`);
  await exec('wget', ['-nv', downloadUrl, '-O', filePath]);
  if (CACHE_ACTIVE && isCacheFeatureAvailable()) {
    await saveCache([filePath], cacheKey);
  }
}

async function downloadTemplates(): Promise<void> {
  const templatesPath = path.join(GODOT_WORKING_PATH, GODOT_TEMPLATES_FILENAME);
  const cacheKey = `godot-templates-${GODOT_TEMPLATES_DOWNLOAD_URL}`;
  const restoreKey = `godot-templates-`;
  await downloadFile(templatesPath, GODOT_TEMPLATES_DOWNLOAD_URL, cacheKey, restoreKey);
}

async function downloadExecutable(): Promise<void> {
  const executablePath = path.join(GODOT_WORKING_PATH, GODOT_ZIP);
  const cacheKey = `godot-executable-${GODOT_DOWNLOAD_URL}`;
  const restoreKey = `godot-executable-`;
  await downloadFile(executablePath, GODOT_DOWNLOAD_URL, cacheKey, restoreKey);
}

function isGhes(): boolean {
  const ghUrl = new URL(process.env['GITHUB_SERVER_URL'] || 'https://github.com');
  return ghUrl.hostname.toUpperCase() !== 'GITHUB.COM';
}

/**
 * Checks if the cache service is available for this runner.
 * Taken from https://github.com/actions/setup-node/blob/main/src/cache-utils.ts
 */
function isCacheFeatureAvailable(): boolean {
  if (isFeatureAvailable()) return true;

  if (isGhes()) {
    core.warning(
      'Cache action is only supported on GHES version >= 3.5. If you are on version >=3.5 Please check with GHES admin if Actions cache service is enabled or not.',
    );
    return false;
  }

  core.warning('The runner was not able to contact the cache service. Caching will be skipped');

  return false;
}

async function prepareExecutable(): Promise<void> {
  const zipFile = path.join(GODOT_WORKING_PATH, GODOT_ZIP);
  const zipTo = path.join(GODOT_WORKING_PATH, GODOT_EXECUTABLE);
  await exec('7z', ['x', zipFile, `-o${zipTo}`, '-y']);
  const executablePath = findGodotExecutablePath(zipTo);
  if (!executablePath) {
    throw new Error('Could not find Godot executable');
  }
  core.info(`Found executable at ${executablePath}`);

  await exec('chmod', ['+x', executablePath]);
  godotExecutablePath = executablePath;
}

/**
 * Checks if the templates have already been downloaded.
 * Only useful for self-hosted runners. On Cloud runners, the templates should always be missing.
 */
async function checkTemplatesStatus(): Promise<'missing' | 'outdated' | 'up-to-date' | 'unknown'> {
  const templatesVersionFile = path.join(GODOT_TEMPLATES_PATH, 'templates_version');
  if (fs.existsSync(templatesVersionFile)) {
    const templatesVersion = fs.readFileSync(templatesVersionFile, 'utf8');
    if (templatesVersion === GODOT_TEMPLATES_DOWNLOAD_URL) {
      return 'up-to-date';
    } else {
      return 'outdated';
    }
  } else if (fs.existsSync(GODOT_TEMPLATES_PATH)) {
    // templates folder exists but no version file
    return 'unknown';
  }

  return 'missing';
}

async function prepareTemplates3(): Promise<void> {
  const templateFile = path.join(GODOT_WORKING_PATH, GODOT_TEMPLATES_FILENAME);
  const tmpPath = path.join(GODOT_WORKING_PATH, 'tmp');
  const godotVersion = await getGodotVersion();

  await exec('unzip', ['-q', templateFile, '-d', GODOT_WORKING_PATH]);
  await exec('mv', [GODOT_TEMPLATES_PATH, tmpPath]);
  await io.mkdirP(GODOT_TEMPLATES_PATH);
  await exec('mv', [tmpPath, path.join(GODOT_TEMPLATES_PATH, godotVersion)]);

  // store the downloaded template URL so we can check if the template has already been downloaded
  const templatesVersionFile = path.join(GODOT_TEMPLATES_PATH, 'templates_version');
  fs.writeFileSync(templatesVersionFile, GODOT_TEMPLATES_DOWNLOAD_URL);
}

async function prepareTemplates(): Promise<void> {
  const templateFile = path.join(GODOT_WORKING_PATH, GODOT_TEMPLATES_FILENAME);
  const godotVersion = await getGodotVersion();
  const godotVersionPath = path.join(GODOT_WORKING_PATH, godotVersion);

  await exec('unzip', [templateFile, '-d', GODOT_WORKING_PATH]);
  await io.mkdirP(GODOT_EXPORT_TEMPLATES_PATH);
  await exec('mv', [GODOT_TEMPLATES_PATH, godotVersionPath]);
  await exec('mv', [godotVersionPath, GODOT_EXPORT_TEMPLATES_PATH]);

  // store the downloaded template URL so we can check if the template has already been downloaded
  const templatesVersionFile = path.join(GODOT_TEMPLATES_PATH, 'templates_version');
  fs.writeFileSync(templatesVersionFile, GODOT_TEMPLATES_DOWNLOAD_URL);
}

async function getGodotVersion(): Promise<string> {
  let version = '';
  const options: ExecOptions = {
    ignoreReturnCode: true,
    listeners: {
      stdout: (data: Buffer) => {
        version += data.toString('utf-8');
      },
    },
  };

  await exec(godotExecutablePath, ['--version'], options);
  let versionLines = version.split(/\r?\n|\r|\n/g);
  versionLines = versionLines.filter(x => !!x.trim());
  version = versionLines.pop() || 'unknown';
  version = version.trim();
  version = version.replace('.official', '').replace(/\.[a-z0-9]{9}$/g, '');

  if (!version) {
    throw new Error('Godot version could not be determined.');
  }

  return version;
}

/**
 * Converts a number to an emoji number. For example, 123 becomes 1️⃣2️⃣3️⃣
 */
function getEmojiNumber(number: number): string {
  const allEmojiNumbers = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
  let emojiNumber = '';

  for (const digit of number.toString()) {
    emojiNumber += allEmojiNumbers[parseInt(digit)];
  }

  return emojiNumber;
}

async function doExport(): Promise<BuildResult[]> {
  const buildResults: BuildResult[] = [];
  core.info(`🎯 Using project file at ${GODOT_PROJECT_FILE_PATH}`);

  let exportPresetIndex = 0;

  for (const preset of getExportPresets()) {
    core.startGroup(`${getEmojiNumber(++exportPresetIndex)} Export binary for preset "${preset.name}"`);

    const sanitizedName = sanitize(preset.name);
    const buildDir = path.join(GODOT_BUILD_PATH, sanitizedName);

    let executablePath;
    if (preset.export_path) {
      executablePath = path.join(buildDir, path.basename(preset.export_path));
    }

    if (!executablePath) {
      core.warning(`No file path set for preset "${preset.name}". Skipping export!`);
      core.endGroup();
      continue;
    }

    if (EXPORT_PACK_ONLY) {
      executablePath += '.pck';
    }

    await io.mkdirP(buildDir);
    let exportFlag = EXPORT_DEBUG ? '--export-debug' : '--export-release';
    if (EXPORT_PACK_ONLY) {
      exportFlag = '--export-pack';
    }
    if (USE_GODOT_3 && !EXPORT_PACK_ONLY) {
      exportFlag = EXPORT_DEBUG ? '--export-debug' : '--export';
    }

    let args = [GODOT_PROJECT_FILE_PATH, '--headless', exportFlag, preset.name, executablePath];
    if (USE_GODOT_3) {
      args = args.filter(x => x !== '--headless');
    }
    if (GODOT_VERBOSE) {
      args.push('--verbose');
    }

    const result = await exec(godotExecutablePath, args);
    if (result !== 0) {
      core.endGroup();
      throw new Error('1 or more exports failed');
    }

    const directoryEntries = fs.readdirSync(buildDir);
    buildResults.push({
      preset,
      sanitizedName,
      executablePath,
      directoryEntryCount: directoryEntries.length,
      directory: buildDir,
    });

    core.endGroup();
  }

  return buildResults;
}

function findGodotExecutablePath(basePath: string): string | undefined {
  const paths = fs.readdirSync(basePath);
  const dirs: string[] = [];
  for (const subPath of paths) {
    const fullPath = path.join(basePath, subPath);
    const stats = fs.statSync(fullPath);
    // || path.basename === 'Godot' && process.platform === 'darwin';
    const isLinux = stats.isFile() && (path.extname(fullPath) === '.64' || path.extname(fullPath) === '.x86_64');
    const isMac = stats.isDirectory() && path.extname(fullPath) === '.app' && process.platform === 'darwin';
    if (isLinux) {
      return fullPath;
    } else if (isMac) {
      // https://docs.godotengine.org/en/stable/tutorials/editor/command_line_tutorial.html
      return path.join(fullPath, 'Contents/MacOS/Godot');
    } else {
      dirs.push(fullPath);
    }
  }
  for (const dir of dirs) {
    return findGodotExecutablePath(dir);
  }
  return undefined;
}

function getExportPresets(): ExportPreset[] {
  const exportPresets: ExportPreset[] = [];
  const projectPath = path.resolve(RELATIVE_PROJECT_PATH);

  if (!hasExportPresets()) {
    throw new Error(`Could not find export_presets.cfg in ${projectPath}`);
  }

  const exportFilePath = path.join(projectPath, 'export_presets.cfg');
  const iniStr = fs.readFileSync(exportFilePath, { encoding: 'utf8' });
  const presets = ini.decode(iniStr) as ExportPresets;

  if (presets?.preset) {
    for (const key in presets.preset) {
      const currentPreset = presets.preset[key];

      // If no presets are specified, export all of them. Otherwise only specified presets are exported.
      if (PRESETS_TO_EXPORT == null || PRESETS_TO_EXPORT.includes(currentPreset.name)) {
        exportPresets.push(currentPreset);
      } else {
        core.info(`🚫 Skipping export preset "${currentPreset.name}"`);
      }
    }
  } else {
    core.warning(`No presets found in export_presets.cfg at ${projectPath}`);
  }

  return exportPresets;
}

async function addEditorSettings(): Promise<void> {
  const editorSettingsDist = path.join(__dirname, EDITOR_SETTINGS_FILENAME);
  await io.mkdirP(GODOT_CONFIG_PATH);

  const editorSettingsPath = path.join(GODOT_CONFIG_PATH, EDITOR_SETTINGS_FILENAME);
  await io.cp(editorSettingsDist, editorSettingsPath, { force: false });
  core.info(`Wrote editor settings to ${editorSettingsPath}`);
}

function configureWindowsExport(): void {
  core.startGroup('📝 Appending Wine editor settings');
  const rceditPath = path.join(__dirname, 'rcedit-x64.exe');
  const linesToWrite: string[] = [];

  core.info(`Writing rcedit path to editor settings ${rceditPath}`);
  core.info(`Writing wine path to editor settings ${WINE_PATH}`);

  const editorSettingsPath = path.join(GODOT_CONFIG_PATH, EDITOR_SETTINGS_FILENAME);
  linesToWrite.push(`export/windows/rcedit = "${rceditPath}"\n`);
  linesToWrite.push(`export/windows/wine = "${WINE_PATH}"\n`);

  fs.writeFileSync(editorSettingsPath, linesToWrite.join(''), { flag: 'a' });

  core.info(linesToWrite.join(''));
  core.info(`Wrote settings to ${editorSettingsPath}`);
  core.endGroup();
}

function configureAndroidExport(): void {
  core.startGroup('📝 Appending Android editor settings');

  const editorSettingsPath = path.join(GODOT_CONFIG_PATH, EDITOR_SETTINGS_FILENAME);
  const linesToWrite: string[] = [];

  linesToWrite.push(`export/android/android_sdk_path = "${ANDROID_SDK_PATH}"\n`);
  fs.writeFileSync(editorSettingsPath, linesToWrite.join(''), { flag: 'a' });

  // making the gradlew executable only on unix systems
  // if the file is not executable, the build will typically fail in incredibly cryptic ways
  if (process.platform !== 'win32') {
    try {
      if (fs.existsSync(path.join(GODOT_PROJECT_PATH, 'android/build/gradlew'))) {
        fs.chmodSync(path.join(GODOT_PROJECT_PATH, 'android/build/gradlew'), '755');
      }
      core.info('Made gradlew executable.');
    } catch (error) {
      core.warning(
        `Could not make gradlew executable. If you are getting cryptic build errors with your Android export, this may be the cause. ${error}`,
      );
    }
  }

  core.info(linesToWrite.join(''));
  core.info(`Wrote Android settings to ${editorSettingsPath}`);
  core.endGroup();
}

/** Open the editor in headless mode once, to import all assets, creating the `.godot` directory if it doesn't exist. */
async function importProject(): Promise<void> {
  core.startGroup('🎲 Import project');
  await exec(godotExecutablePath, [GODOT_PROJECT_FILE_PATH, '--headless', '-e', '--quit']);
  core.endGroup();
}

export { exportBuilds };
