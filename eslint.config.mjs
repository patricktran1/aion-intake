import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescriptConfig from "eslint-config-next/typescript";

/** Next.js 16 ships flat configs directly; no eslintrc compatibility layer needed. */
const eslintConfig = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts", "*.tsbuildinfo"] },
  ...coreWebVitals,
  ...typescriptConfig,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];

export default eslintConfig;
