// TODO: types (#22198)
import { logger } from '../../../logger';
import { newlineRegex, regEx } from '../../../util/regex';
import type { UpdateDependencyConfig } from '../types';

function getDepNameWithNoVersion(depName: string): string {
  let depNameNoVersion = depName.split('/').slice(0, 3).join('/');
  if (depNameNoVersion.startsWith('gopkg.in')) {
    depNameNoVersion = depNameNoVersion.replace(regEx(/\.v\d+$/), '');
  }
  return depNameNoVersion;
}

export function updateDependency({
  fileContent,
  upgrade,
}: UpdateDependencyConfig): string | null {
  try {
    logger.debug(`gomod.updateDependency: ${upgrade.newValue}`);
    const { depType, newName } = upgrade;
    const fromPackageName = upgrade.depName
    // newName will be available for replacement
    const toPackageName = newName ?? fromPackageName
    // istanbul ignore if: should never happen
    if (!fromPackageName || !toPackageName || !upgrade.managerData) {
      return null;
    }
    const fromPackageNameNoVersion = getDepNameWithNoVersion(fromPackageName);
    const lines = fileContent.split(newlineRegex);
    // istanbul ignore if: hard to test
    if (lines.length <= upgrade.managerData.lineNumber) {
      logger.warn('go.mod current line no longer exists after update');
      return null;
    }
    const lineToChange = lines[upgrade.managerData.lineNumber];
    logger.trace({ upgrade, lineToChange }, 'go.mod current line');
    if (
      !lineToChange.includes(fromPackageNameNoVersion) &&
      // TODO *******************************************
      // TODO also check toPackageNameNoVersion ?
      // TODO *******************************************
      !lineToChange.includes('rethinkdb/rethinkdb-go.v5')
    ) {
      logger.debug(
        { lineToChange, depName: toPackageName },
        "go.mod current line doesn't contain dependency",
      );
      return null;
    }
    let updateLineExp: RegExp | undefined;

    if (depType === 'golang' || depType === 'toolchain') {
      updateLineExp = regEx(
        /(?<depPart>(?:toolchain )?go)(?<divider>\s*)([^\s]+|[\w]+)/,
      );
    }
    if (depType === 'replace') {
      if (upgrade.managerData.multiLine) {
        updateLineExp = regEx(
          /^(?<depPart>\s+[^\s]+[\s]+[=][>]+\s+)(?<depName>[^\s]+)(?<divider>\s+)[^\s]+/,
        );
      } else {
        updateLineExp = regEx(
          /^(?<depPart>replace\s+[^\s]+[\s]+[=][>]+\s+)(?<depName>[^\s]+)(?<divider>\s+)[^\s]+/,
        );
      }
    } else if (depType === 'require' || depType === 'indirect') {
      if (upgrade.managerData.multiLine) {
        updateLineExp = regEx(/^(?<depPart>\s+)(?<depName>[^\s]+)(?<divider>\s+)[^\s]+/);
      } else {
        updateLineExp = regEx(
          /^(?<depPart>require\s+)(?<depName>[^\s]+)(?<divider>\s+)[^\s]+/,
        );
      }
    }
    if (updateLineExp && !updateLineExp.test(lineToChange)) {
      logger.debug('No line found to update');
      return null;
    }
    let newLine: string;
    if (
      upgrade.updateType === 'digest' ||
      upgrade.updateType === 'replacement' && upgrade.newDigest
    ) {
      const newDigestRightSized = upgrade.newDigest!.substring(
        0,
        upgrade.currentDigest!.length,
      );
      if (lineToChange.includes(newDigestRightSized)) {
        return fileContent;
      }
      logger.debug(
        { depName: toPackageName, lineToChange, newDigestRightSized },
        'gomod: need to update digest',
      );
      newLine = lineToChange.replace(
        // TODO: can be undefined? (#22198)
        updateLineExp!,
        `$<depPart>${toPackageName}$<divider>${newDigestRightSized}`,
      );
    } else {
      newLine = lineToChange.replace(
        // TODO: can be undefined? (#22198)
        updateLineExp!,
        `$<depPart>${toPackageName}$<divider>${upgrade.newValue}`,
      );
    }
    if (
      upgrade.updateType === 'major' ||
      upgrade.updateType === 'replacement' && upgrade.newMajor
    ) {
      logger.debug(`gomod: major update for ${toPackageName}`);
      if (toPackageName.startsWith('gopkg.in/')) {
        const oldV = toPackageName.split('.').pop();
        newLine = newLine.replace(`.${oldV}`, `.v${upgrade.newMajor}`);
        // Package renames - I couldn't think of a better place to do this
        newLine = newLine.replace(
          'gorethink/gorethink.v5',
          'rethinkdb/rethinkdb-go.v5',
        );
      } else if (
        upgrade.newMajor! > 1 &&
        !newLine.includes(`/v${upgrade.newMajor}`) &&
        !upgrade.newValue!.endsWith('+incompatible')
      ) {
        if (fromPackageName === fromPackageNameNoVersion) { // TODO
          // If package currently has no version, pin to latest one.
          newLine = newLine.replace(fromPackageName, `${fromPackageName}/v${upgrade.newMajor}`);
        } else {
          // Replace version
          const [oldV] = upgrade.currentValue!.split('.');
          newLine = newLine.replace(
            regEx(`/${oldV}(\\s+)`, undefined, false),
            `/v${upgrade.newMajor}$1`,
          );
        }
      }
    }
    if (
      lineToChange.endsWith('+incompatible') &&
      !upgrade.newValue?.endsWith('+incompatible')
    ) {
      let toAdd = '+incompatible';

      if (upgrade.updateType === 'major' && upgrade.newMajor! >= 2) {
        toAdd = '';
      }
      newLine += toAdd;
    }
    if (newLine === lineToChange) {
      logger.debug('No changes necessary');
      return fileContent;
    }

    if (depType === 'indirect') {
      newLine = newLine.replace(
        regEx(/\s*(?:\/\/\s*indirect(?:\s*;)?\s*)*$/),
        ' // indirect',
      );
    }

    lines[upgrade.managerData.lineNumber] = newLine;
    return lines.join('\n');
  } catch (err) {
    logger.debug({ err }, 'Error setting new go.mod version');
    return null;
  }
}
