import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const locales = ["ja", "en", "zh-Hans", "ko"];
const catalogPath = path.join(root, "ios/Resources/Localizable.xcstrings");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

assert.equal(catalog.sourceLanguage, "ja", "Japanese must remain the source language");
assert.equal(catalog.version, "1.0");
assert.ok(Object.keys(catalog.strings).length > 0, "localization catalog must not be empty");

for (const [key, entry] of Object.entries(catalog.strings)) {
  const placeholderSignatures = new Map();
  for (const locale of locales) {
    const unit = entry.localizations?.[locale]?.stringUnit;
    assert.ok(unit, `missing ${locale} translation for: ${key}`);
    assert.equal(unit.state, "translated", `unfinished ${locale} translation for: ${key}`);
    assert.ok(unit.value?.trim(), `empty ${locale} translation for: ${key}`);
    placeholderSignatures.set(
      locale,
      [...unit.value.matchAll(/%(?:\d+\$)?(?:@|lld|ld|d|f)/g)].map((match) => match[0].replace(/^%\d+\$/, "%")),
    );
  }
  const expectedPlaceholders = JSON.stringify(placeholderSignatures.get("ja"));
  for (const locale of locales.slice(1)) {
    assert.equal(
      JSON.stringify(placeholderSignatures.get(locale)),
      expectedPlaceholders,
      `placeholder mismatch for ${key}: ja=${expectedPlaceholders}, ${locale}=${JSON.stringify(placeholderSignatures.get(locale))}`,
    );
  }
}

const sourceRoot = path.join(root, "ios/Sources");
const swiftFiles = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".swift"))
  .map((entry) => path.join(entry.parentPath, entry.name));
const japaneseLiteral = /"((?:\\.|[^"\\])*)"/g;
const japaneseCharacters = /[ぁ-んァ-ヶ一-龠々ー]/;
const semanticKey = /"((?:upload|compression|error|api|accessibility|timeline|memory|playback|mcp|common)\.[a-z0-9_.]+)"/g;
for (const file of swiftFiles) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(japaneseLiteral)) {
    const value = match[1].replaceAll("\\n", "\n");
    if (!japaneseCharacters.test(value)) continue;
    assert.ok(
      !value.includes("\\("),
      `interpolated Japanese string must use a semantic L10n.format key: ${path.relative(root, file)}: ${value}`,
    );
    assert.ok(
      catalog.strings[value],
      `Japanese source literal is missing from Localizable.xcstrings: ${path.relative(root, file)}: ${value}`,
    );
  }
  for (const match of source.matchAll(semanticKey)) {
    assert.ok(
      catalog.strings[match[1]],
      `semantic localization key is missing from Localizable.xcstrings: ${path.relative(root, file)}: ${match[1]}`,
    );
  }
}

for (const locale of locales) {
  const mainInfo = readFileSync(
    path.join(root, `ios/Resources/Localization/${locale}.lproj/InfoPlist.strings`),
    "utf8",
  );
  assert.match(mainInfo, /"NSPhotoLibraryUsageDescription"\s*=\s*"[^"\n]+";/);

  const widgetInfo = readFileSync(
    path.join(root, `ios/AfterimageUploadWidget/Localization/${locale}.lproj/InfoPlist.strings`),
    "utf8",
  );
  assert.match(widgetInfo, /"CFBundleDisplayName"\s*=\s*"[^"\n]+";/);
}

const project = readFileSync(path.join(root, "ios/project.yml"), "utf8");
assert.match(project, /Resources\/Localizable\.xcstrings/);
assert.match(project, /Resources\/Localization/);
assert.match(project, /AfterimageUploadWidget\/Localization/);
for (const locale of locales) {
  assert.ok(project.includes(`- ${locale}`), `project.yml missing known region: ${locale}`);
}

console.log(`iOS localization contract: PASS (${Object.keys(catalog.strings).length} keys × ${locales.length} locales)`);
