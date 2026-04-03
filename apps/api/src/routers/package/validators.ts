import semver from "semver";
import { z } from "zod";

function isValidNpmSemver(value: string): boolean {
	try {
		const isValidSemver = semver.clean(value, { loose: true }) !== null;
		return isValidSemver;
	} catch {
		return false;
	}
}

const packageSchema = z.object({
	_id: z.string(),
	name: z.string(),
	"dist-tags": z.record(z.string(), z.string()),
	versions: z.record(z.string(), z.any())
});

const npmSemver = z
	.string()
	.refine((value) => isValidNpmSemver(value), { message: "Version is not in a vlid npm-style semv" });

export const validators = {
	get: {
		request: {
			param: z.object({
				packageName: z.string().nonempty()
			})
		},
		scoped: {
			request: {
				param: z.object({
					packageScope: z.string().nonempty(),
					packageName: z.string().nonempty()
				})
			}
		},
		response: {
			200: packageSchema
		}
	},
	getTarball: {
		request: {
			param: z.object({
				packageName: z.string().nonempty(),
				tarballName: z.string().nonempty()
			})
		},
		scope: {
			request: {
				param: z.object({
					packageScope: z.string().nonempty(),
					packageName: z.string().nonempty(),
					tarballName: z.string().nonempty()
				})
			}
		}
	},
	put: {
		request: {
			param: z.object({
				packageName: z.string().nonempty()
			}),
			json: z.object({
				_id: z.string().min(1),
				name: z.string().min(1),
				"dist-tags": z.record(z.string(), z.string()),
				versions: z.record(
					npmSemver,
					z.object({
						_id: z.string().min(1),
						name: z.string().min(1),
						type: z.string().optional(),
						version: npmSemver,
						readme: z.string(),
						scripts: z.record(z.string(), z.string()).optional(),
						devDependencies: z.record(z.string(), z.string()).optional(),
						dependencies: z.record(z.string(), z.string()).optional(),
						_nodeVersion: z.string().optional(),
						_npmVersion: z.string().optional(),
						dist: z.object({
							integrity: z.string(),
							shasum: z.string(),
							tarball: z.string()
						})
					})
				),
				_attachments: z.record(
					z.string(),
					z.object({
						content_type: z.string(),
						data: z.string(),
						length: z.number()
					})
				)
			})
		},
		scoped: {
			request: {
				param: z.object({
					packageScope: z.string().nonempty(),
					packageName: z.string().nonempty()
				})
			}
		},
		response: {
			200: z.object({ message: z.string() })
		}
	}
};