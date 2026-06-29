import { defineConfig } from "vite-plus"

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    entry: "src/server.ts",
    outDir: "bin",
    format: "esm",
    platform: "node",
    clean: true,
    minify: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  fmt: {
    printWidth: 100,
    semi: false,
    trailingComma: "all",
  },
  lint: {
    plugins: ["typescript", "unicorn", "oxc"],
    categories: {
      correctness: "error",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "eslint/no-await-in-loop": "off",
      "eslint/no-new": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-useless-default-assignment": "off",
      "unicorn/prefer-node-protocol": "off",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
})
