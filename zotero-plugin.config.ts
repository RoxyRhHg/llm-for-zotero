import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";
import { patchGeneratedWorkflowTestReporter } from "./scripts/workflow-test-reporter.mjs";

const webChatLiveTestsEnabled = process.env.LLM_FOR_ZOTERO_WEBCHAT_LIVE === "1";
const workflowTestsEnabled =
  webChatLiveTestsEnabled || process.env.LLM_FOR_ZOTERO_WORKFLOW_TESTS === "1";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    fluent: {
      prefixFluentMessages: false,
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        loader: { ".md": "text" },
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    entries: webChatLiveTestsEnabled
      ? "test-live-workflows"
      : workflowTestsEnabled
        ? "test-workflows"
        : "test",
    ...(workflowTestsEnabled
      ? {
          abortOnFail: true,
          mocha: { timeout: webChatLiveTestsEnabled ? 720000 : 30000 },
          watch: false,
        }
      : {}),
    hooks: {
      "test:bundleTests": () => patchGeneratedWorkflowTestReporter(),
    },
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
