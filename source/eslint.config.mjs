import powerbiVisualsConfigs from "eslint-plugin-powerbi-visuals";
import tseslint from "typescript-eslint";

export default [
    {
        ignores: ["node_modules/**", "dist/**", ".vscode/**", ".tmp/**", "webpack.statistics.*", "test/**", "tools/**"],
    },
    powerbiVisualsConfigs.configs.recommended,
    ...tseslint.configs.recommended.map((config) => ({
        ...config,
        files: ["src/**/*.ts"],
    })),
    {
        files: ["src/**/*.ts"],
        rules: {
            "@typescript-eslint/no-explicit-any": "error",
            "no-eval": "error",
            "no-implied-eval": "error",
            "no-new-func": "error",
        },
    },
];
