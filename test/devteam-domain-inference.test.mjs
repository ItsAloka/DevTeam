import test from "node:test";
import assert from "node:assert/strict";
import { DOMAIN_ORDER, EVIDENCE_PER_DOMAIN, suggestDomains } from "../src/devteam/domain-inference.mjs";
import { DOMAINS } from "../src/devteam/store.mjs";

const NO_MARKER = "No clear domain marker; declare domains explicitly.";

test("domain inference returns conservative, evidence-backed suggestions", () => {
  assert.deepEqual(suggestDomains([
    "Dockerfile", ".github/workflows/test.yml", "src/api/users.mjs", "docs/runbook.md",
  ]), {
    domains: ["backend", "devops", "docs"],
    evidence: {
      backend: { paths: ["src/api/users.mjs"], total: 1 },
      devops: { paths: ["Dockerfile", ".github/workflows/test.yml"], total: 2 },
      docs: { paths: ["docs/runbook.md"], total: 1 },
    },
    note: null,
  });
});

test("domain inference does not guess from ordinary files or desktop/game markers", () => {
  assert.deepEqual(suggestDomains(["src/main.mjs", "README.md", "unity/ProjectSettings.asset", "electron/main.js"]), {
    domains: [], evidence: {}, note: NO_MARKER,
  });
});

test("domain inference refuses broad, ambiguous project matches", () => {
  assert.deepEqual(suggestDomains([
    "pubspec.yaml", "notebooks/train.ipynb", "warehouse/events.parquet", "Dockerfile",
  ]), {
    domains: [], evidence: {},
    note: "More than three domains matched; declare domains explicitly rather than guessing.",
  });
});

test("exactly three domains is still suggested", () => {
  assert.deepEqual(suggestDomains(["pubspec.yaml", "Dockerfile", "docs/intro.md"]).domains, ["mobile", "devops", "docs"]);
});

test("an MVC models/ folder is not machine learning", () => {
  const result = suggestDomains(["src/models/user.js", "src/routes/users.js", "package.json"]);
  assert.deepEqual(result.domains, ["backend"]);
  assert.deepEqual(suggestDomains(["app/models/order.rb"]).domains, []);
  assert.deepEqual(suggestDomains(["weights/model.onnx"]).domains, ["ml"], "real ML artifacts still count");
});

test("a Swift or Kotlin server is not mobile", () => {
  assert.deepEqual(suggestDomains(["Package.swift", "Sources/App/main.swift"]).domains, []);
  assert.deepEqual(suggestDomains(["src/main/kotlin/Application.kt", "build.gradle.kts"]).domains, []);
  assert.deepEqual(suggestDomains(["ios/Runner/AppDelegate.swift"]).domains, ["mobile"]);
  assert.deepEqual(suggestDomains(["app/src/main/AndroidManifest.xml"]).domains, ["mobile"]);
});

test("test fixtures and vendored files are never evidence", () => {
  assert.deepEqual(suggestDomains(["test/fixtures/sample.csv", "tests/data/events.parquet", "node_modules/x/Dockerfile", "examples/app/index.html"]), {
    domains: [], evidence: {}, note: NO_MARKER,
  });
  assert.deepEqual(suggestDomains(["some/export.csv"]).domains, [], "a loose CSV is not a data project");
});

test("evidence is capped per domain, counts every match, and keeps original spelling", () => {
  const many = Array.from({ length: 5000 }, (_, index) => `models/Checkpoint${index}.PT`);
  const result = suggestDomains(many);
  assert.deepEqual(result.domains, ["ml"]);
  assert.equal(result.evidence.ml.paths.length, EVIDENCE_PER_DOMAIN);
  assert.equal(result.evidence.ml.total, 5000);
  assert.equal(result.evidence.ml.paths[0], "models/Checkpoint0.PT");
  assert.ok(JSON.stringify(result).length < 1024);
  assert.equal(suggestDomains(["Dockerfile", "./Dockerfile", "dockerfile"]).evidence.devops.total, 1, "the same file is counted once");
});

test("the domain order is the canonical enum, not a copy", () => {
  assert.equal(DOMAIN_ORDER, DOMAINS);
});
