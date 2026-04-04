import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import type { z } from "zod";
import { db } from "#db/index";
import { packageReleaseTable, packageTable } from "#db/schema";
import type { validators } from "#routers/package/validators";
import { base64ToReadableStream } from "#utils/common";
import { HttpError } from "#utils/http";

type PutPackageBody = z.infer<typeof validators.put.request.json>;
type Attachment = PutPackageBody["_attachments"][string];

type ServiceDebugOptions = {
	debug?: boolean;
};

function normalizePackageName(packageName: string) {
	try {
		return decodeURIComponent(packageName);
	} catch {
		return packageName;
	}
}

function safeJson(value: unknown) {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function withDebugMessage(message: string, details: unknown, debug = false) {
	if (!debug) return message;
	return `${message}\n\n--- npflared debug ---\n${safeJson(details)}`;
}

function badRequest(message: string, details?: unknown, debug = false): never {
	throw HttpError.badRequest(withDebugMessage(message, details, debug));
}

function conflict(message: string, details?: unknown, debug = false): never {
	throw HttpError.conflict(withDebugMessage(message, details, debug));
}

function internal(message: string, details?: unknown, debug = false): never {
	throw HttpError.internalServerError(withDebugMessage(message, details, debug));
}

function notFound(message: string, details?: unknown, debug = false): never {
	throw HttpError.notFound(withDebugMessage(message, details, debug));
}

function getTarballFileNameFromUrl(tarballUrl: string) {
	try {
		const url = new URL(tarballUrl);
		return decodeURIComponent(url.pathname.split("/").pop() ?? "");
	} catch {
		throw HttpError.badRequest("Invalid tarball url");
	}
}

function getScopedLeafName(packageName: string) {
	const normalized = normalizePackageName(packageName);
	return normalized.split("/").pop() ?? normalized;
}

function getAllowedScopedTarballNames(packageName: string, version: string) {
	const normalized = normalizePackageName(packageName);
	const leafName = getScopedLeafName(normalized);
	const withoutAt = normalized.startsWith("@") ? normalized.slice(1) : normalized;

	const leafTarball = `${leafName}-${version}.tgz`;
	const flattenedScoped = `${withoutAt.replace(/\//g, "-")}-${version}.tgz`;
	const legacyScoped = `${normalized.replace(/\//g, "-")}-${version}.tgz`;

	return new Set([leafTarball, flattenedScoped, legacyScoped]);
}

function getAttachmentMatchCandidates(rawName: string) {
	const out = new Set<string>();

	const addCandidateSet = (value: string) => {
		const decoded = (() => {
			try {
				return decodeURIComponent(value);
			} catch {
				return value;
			}
		})();

		for (const current of [value, decoded]) {
			const basename = current.split("/").pop() ?? current;
			const noAt = current.startsWith("@") ? current.slice(1) : current;
			const noAtBasename = noAt.split("/").pop() ?? noAt;
			const flattened = noAt.replace(/\//g, "-");
			const flattenedLegacy = current.replace(/\//g, "-");

			out.add(current);
			out.add(basename);
			out.add(noAt);
			out.add(noAtBasename);
			out.add(flattened);
			out.add(flattenedLegacy);

			try {
				const asUrl = new URL(current);
				const pathname = decodeURIComponent(asUrl.pathname);
				const urlBasename = pathname.split("/").pop() ?? pathname;
				out.add(pathname);
				out.add(urlBasename);
			} catch {}
		}
	};

	addCandidateSet(rawName);

	return out;
}

function summarizeAttachments(attachments: PutPackageBody["_attachments"] | undefined) {
	if (!attachments) return [];

	return Object.entries(attachments).map(([name, value]) => ({
		name,
		contentType: value.content_type,
		length: value.length,
		candidates: [...getAttachmentMatchCandidates(name)]
	}));
}

function summarizeVersions(packageData: PutPackageBody) {
	return Object.entries(packageData.versions ?? {}).map(([version, manifest]) => ({
		version,
		name: manifest.name,
		manifestVersion: manifest.version,
		tarball: manifest.dist?.tarball
	}));
}

function resolveTarballNames(
	packageName: string,
	packageData: PutPackageBody,
	version: string,
	options: ServiceDebugOptions = {}
) {
	const debug = options.debug === true;
	const normalizedPackageName = normalizePackageName(packageName);
	const manifest = packageData.versions[version];

	if (!manifest) {
		badRequest(
			"No versions",
			{
				packageName,
				normalizedPackageName,
				requestedVersion: version,
				availableVersions: Object.keys(packageData.versions ?? {}),
				distTags: packageData["dist-tags"]
			},
			debug
		);
	}

	const tarballUrl = manifest.dist?.tarball;
	if (!tarballUrl) {
		badRequest(
			"No tarball url",
			{
				packageName,
				normalizedPackageName,
				version,
				manifest: {
					_id: manifest._id,
					name: manifest.name,
					version: manifest.version,
					dist: manifest.dist ?? null
				}
			},
			debug
		);
	}

	const publicTarballName = getTarballFileNameFromUrl(tarballUrl);

	const attachments = packageData._attachments ?? {};
	const attachmentNames = Object.keys(attachments);

	if (attachmentNames.length === 0) {
		badRequest(
			"No attachment",
			{
				packageName,
				normalizedPackageName,
				version,
				tarballUrl,
				publicTarballName,
				attachmentNames,
				versions: summarizeVersions(packageData)
			},
			debug
		);
	}

	if (!normalizedPackageName.startsWith("@")) {
		if (!attachmentNames.includes(publicTarballName)) {
			badRequest(
				"Attachment name does not match",
				{
					mode: "unscoped",
					packageName,
					normalizedPackageName,
					version,
					tarballUrl,
					publicTarballName,
					attachmentNames,
					attachments: summarizeAttachments(packageData._attachments)
				},
				debug
			);
		}

		return {
			manifest,
			publicTarballName,
			attachmentName: publicTarballName
		};
	}

	const allowedNames = [...getAllowedScopedTarballNames(normalizedPackageName, version)];

	const directAttachmentMatch = attachmentNames
		.map((rawName) => {
			const candidates = [...getAttachmentMatchCandidates(rawName)];
			return {
				rawName,
				candidates,
				matchedCandidate: candidates.find(
					(candidate) => candidate === publicTarballName || allowedNames.includes(candidate)
				)
			};
		})
		.find((entry) => entry.matchedCandidate);

	if (directAttachmentMatch) {
		return {
			manifest,
			publicTarballName,
			attachmentName: directAttachmentMatch.rawName
		};
	}

	if (attachmentNames.length === 1) {
		const onlyAttachmentName = attachmentNames[0];

		if (!onlyAttachmentName) {
			badRequest(
				"No attachment",
				{
					packageName,
					normalizedPackageName,
					version,
					tarballUrl,
					publicTarballName,
					attachmentNames
				},
				debug
			);
		}

		return {
			manifest,
			publicTarballName,
			attachmentName: onlyAttachmentName
		};
	}

	badRequest(
		"Attachment name does not match",
		{
			mode: "scoped",
			packageName,
			normalizedPackageName,
			version,
			tarballUrl,
			publicTarballName,
			allowedScopedTarballNames: allowedNames,
			attachmentNames,
			attachments: summarizeAttachments(packageData._attachments),
			versions: summarizeVersions(packageData),
			distTags: packageData["dist-tags"]
		},
		debug
	);
}

export const packageService = {
	async getPackage(packageName: string) {
		const normalizedPackageName = normalizePackageName(packageName);

		const publishedPackage = await db.query.packageTable.findFirst({
			with: { packageReleases: true },
			where: (table, { eq }) => eq(table.name, normalizedPackageName)
		});

		if (!publishedPackage) return undefined;

		const versions = publishedPackage.packageReleases.reduce(
			(acc, { version, manifest }) => {
				acc[version] = manifest;
				return acc;
			},
			{} as Record<string, unknown>
		);

		return {
			_id: publishedPackage.name,
			name: publishedPackage.name,
			"dist-tags": publishedPackage.distTags,
			versions
		};
	},

	async putPackage(packageName: string, packageData: PutPackageBody, options: ServiceDebugOptions = {}) {
		const debug = options.debug === true;
		const normalizedPackageName = normalizePackageName(packageName);

		const tag = Object.keys(packageData["dist-tags"]).at(0);
		if (!tag) {
			badRequest(
				"No tag",
				{
					packageName,
					normalizedPackageName,
					distTags: packageData["dist-tags"],
					versions: Object.keys(packageData.versions ?? {})
				},
				debug
			);
		}

		const versionToUpload = Object.keys(packageData.versions).at(0);
		if (!versionToUpload) {
			badRequest(
				"No versions",
				{
					packageName,
					normalizedPackageName,
					distTags: packageData["dist-tags"],
					versions: packageData.versions
				},
				debug
			);
		}

		const { manifest, publicTarballName, attachmentName } = resolveTarballNames(
			normalizedPackageName,
			packageData,
			versionToUpload,
			{ debug }
		);

		const attachments = packageData._attachments ?? {};
		const attachment = attachments[attachmentName] as Attachment | undefined;

		if (!attachment) {
			badRequest(
				"No attachment",
				{
					packageName,
					normalizedPackageName,
					versionToUpload,
					attachmentName,
					availableAttachmentNames: Object.keys(attachments),
					attachments: summarizeAttachments(packageData._attachments)
				},
				debug
			);
		}

		const conflictingPackageRelease = await db.query.packageReleaseTable.findFirst({
			columns: { version: true },
			where: (table, { eq, and }) => and(eq(table.package, normalizedPackageName), eq(table.version, versionToUpload))
		});

		if (conflictingPackageRelease) {
			conflict(
				"Version already exists",
				{
					packageName,
					normalizedPackageName,
					versionToUpload,
					tag,
					publicTarballName
				},
				debug
			);
		}

		const now = Date.now();

		const [insertedPackage, insertedPackageVersion] = await db.batch([
			db
				.insert(packageTable)
				.values({
					name: normalizedPackageName,
					createdAt: now,
					updatedAt: now,
					distTags: packageData["dist-tags"]
				})
				.onConflictDoUpdate({
					target: packageTable.name,
					set: {
						updatedAt: now,
						distTags: sql`json_patch(${packageTable.distTags}, ${JSON.stringify(packageData["dist-tags"])})`
					}
				})
				.returning(),
			db
				.insert(packageReleaseTable)
				.values({
					package: normalizedPackageName,
					version: versionToUpload,
					tag,
					manifest,
					createdAt: now
				})
				.returning()
		]);

		const uploadStream = new FixedLengthStream(attachment.length);
		const pipePromise = base64ToReadableStream(attachment.data).pipeTo(uploadStream.writable);

		try {
			await env.BUCKET.put(publicTarballName, uploadStream.readable, {
				httpMetadata: { contentType: "application/gzip" },
				customMetadata: { package: normalizedPackageName, version: versionToUpload }
			});
		} catch (error) {
			internal(
				"Failed to store tarball",
				{
					packageName,
					normalizedPackageName,
					versionToUpload,
					publicTarballName,
					attachmentName,
					attachmentLength: attachment.length,
					error: error instanceof Error ? error.message : String(error)
				},
				debug
			);
		}

		try {
			await pipePromise;
		} catch (error) {
			internal(
				"Failed to stream tarball data",
				{
					packageName,
					normalizedPackageName,
					versionToUpload,
					publicTarballName,
					attachmentName,
					error: error instanceof Error ? error.message : String(error)
				},
				debug
			);
		}

		return {
			package: insertedPackage[0],
			packageVersion: insertedPackageVersion[0]
		};
	},

	async getPackageTarball(packageName: string, tarballName: string, options: ServiceDebugOptions = {}) {
		const debug = options.debug === true;
		const normalizedPackageName = normalizePackageName(packageName);
		const bucket = env.BUCKET as R2Bucket | undefined;

		if (!bucket || !("get" in bucket) || typeof bucket.get !== "function") {
			internal(
				"Storage bucket not configured",
				{
					packageName,
					normalizedPackageName,
					tarballName,
					bucketExists: Boolean(bucket)
				},
				debug
			);
		}

		const packageTarball = await bucket.get(tarballName);

		if (!packageTarball) {
			notFound(
				`Tarball not found: ${tarballName}`,
				{
					packageName,
					normalizedPackageName,
					tarballName
				},
				debug
			);
		}

		if (packageTarball.customMetadata?.package !== normalizedPackageName) {
			internal(
				"Tarball metadata does not match requested package",
				{
					packageName,
					normalizedPackageName,
					tarballName,
					customMetadata: packageTarball.customMetadata ?? null
				},
				debug
			);
		}

		return packageTarball;
	}
};
