module.exports = {
  root: true,
  env: {
    node: true,
    es2020: true
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    sourceType: "module"
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  ignorePatterns: ["dist", "node_modules"],
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
  }
};
