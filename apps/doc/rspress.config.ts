import * as path from "node:path";
import { defineConfig } from "@rspress/core";

export default defineConfig({
	root: path.join(__dirname, "docs"),
	globalStyles: path.join(__dirname, "styles/index.css"),
	title: "Babadeluxe Registry",
	icon: "/logo-minimal.svg",
	logo: {
		light: "/logo.svg",
		dark: "/logo.svg"
	},
	themeConfig: {
		socialLinks: [
			{
				icon: "github",
				mode: "link",
				content: "https://github.com/Thomascogez/babadeluxe-registry"
			}
		]
	},
	markdown: {
		showLineNumbers: true,
		defaultWrapCode: true
	}
});
