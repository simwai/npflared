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

function getTarballFileNameFromUrl(tarballUrl: string) {
	try {
		const url = new URL(tarballUrl);
		return decodeURIComponent(url.pathname.split("/").pop() ?? "");
	} catch {
		throw HttpError.badRequest("Invalid tarball url");
	}
}

function getValidatedTarballFileName(packageData: PutPackageBody, version: string) {
	const tarballUrl = packageData.versions[version]?.dist?.tarball;

	if (!tarballUrl) {
		throw HttpError.badRequest("No tarball url");
	}

	const tarballFileName = getTarballFileNameFromUrl(tarballUrl);
	const attachments = packageData._attachments ?? {};

	if (!tarballFileName || !(tarballFileName in attachments)) {
		throw HttpError.badRequest("Attachment name does not match");
	}

	return tarballFileName;
}

export const packageService = {
	async getPackage(packageName: string) {
		const publishedPackage = await db.query.packageTable.findFirst({
			with: { packageReleases: true },
			where: (table, { eq }) => eq(table.name, packageName)
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

	async putPackage(packageName: string, packageData: PutPackageBody) {
		const tag = Object.keys(packageData["dist-tags"]).at(0);
		if (!tag) {
			throw HttpError.badRequest("No tag");
		}

		const versionToUpload = Object.keys(packageData.versions).at(0);
		if (!versionToUpload) {
			throw HttpError.badRequest("No versions");
		}

		const tarballFileName = getValidatedTarballFileName(packageData, versionToUpload);

		const attachment = packageData._attachments?.[tarballFileName] as Attachment | undefined;
		if (!attachment) {
			throw HttpError.badRequest("No attachment");
		}

		const conflictingPackageRelease = await db.query.packageReleaseTable.findFirst({
			columns: { version: true },
			where: (table, { eq, and }) => and(eq(table.package, packageName), eq(table.version, versionToUpload))
		});

		if (conflictingPackageRelease) {
			throw HttpError.conflict("Version already exists");
		}

		const now = Date.now();

		const [insertedPackage, insertedPackageVersion] = await db.batch([
			db
				.insert(packageTable)
				.values({
					name: packageName,
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
					package: packageName,
					version: versionToUpload,
					tag,
					manifest: packageData.versions[versionToUpload],
					createdAt: now
				})
				.returning()
		]);

		const uploadStream = new FixedLengthStream(attachment.length);
		const pipePromise = base64ToReadableStream(attachment.data).pipeTo(uploadStream.writable);

		await env.BUCKET.put(tarballFileName, uploadStream.readable, {
			httpMetadata: { contentType: "application/gzip" },
			customMetadata: { package: packageName, version: versionToUpload }
		});

		await pipePromise;

		return {
			package: insertedPackage[0],
			packageVersion: insertedPackageVersion[0]
		};
	},

	async getPackageTarball(packageName: string, tarballName: string) {
		const bucket = env.BUCKET as R2Bucket | undefined;

		if (!bucket || typeof (bucket as any).get !== "function") {
			throw HttpError.internalServerError("Storage bucket not configured");
		}

		const packageTarball = await bucket.get(tarballName);

		if (!packageTarball) {
			throw HttpError.notFound(`Tarball not found: ${tarballName}`);
		}

		if (packageTarball.customMetadata?.package !== packageName) {
			throw HttpError.internalServerError("Tarball metadata does not match requested package");
		}

		return packageTarball;
	}
};