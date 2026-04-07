import { env, fetchMock, SELF } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import packagePublishPayload from '../mocks/package-publish-payload.json'
import { createToken } from '../utils'

const publicTarballName = (fullName: string, version: string) => {
  const leaf = fullName.split('/').pop() ?? fullName
  return `${leaf}-${version}.tgz`
}

const attachmentTarballName = (fullName: string, version: string) => {
  if (!fullName.startsWith('@')) return `${fullName}-${version}.tgz`
  return `${fullName.slice(1).replace(/\//g, '-')}-${version}.tgz`
}

const tarballUrl = (fullName: string, version: string) =>
  `http://localhost:8787/${fullName}/-/${publicTarballName(fullName, version)}`

describe('scoped package routes', () => {
  beforeAll(() => {
    fetchMock.activate()
    fetchMock.disableNetConnect()
  })

  afterEach(() => fetchMock.assertNoPendingInterceptors())

  describe('GET /:packageScope/:packageName', () => {
    it('should match scoped package metadata route and fallback to external registry', async () => {
      const { token } = await createToken({
        name: 'test-token',
        scopes: [{ type: 'package:read', values: ['@test/pkg'] }],
      })

      fetchMock.get(env.FALLBACK_REGISTRY_ENDPOINT).intercept({ path: '/@test/pkg' }).reply(200, { name: '@test/pkg' })

      const response = await SELF.fetch('http://localhost/@test/pkg', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ name: '@test/pkg' })
    })

    it('should fallback to external registry without token being required for the fallback', async () => {
      fetchMock
        .get(env.FALLBACK_REGISTRY_ENDPOINT)
        .intercept({ path: '/@fallback/pkg' })
        .reply(200, { name: '@fallback/pkg' })

      const response = await SELF.fetch('http://localhost/@fallback/pkg')

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ name: '@fallback/pkg' })
    })

    it("should return 403 if token doesn't have access to scoped package in local registry", async () => {
      const fullName = '@scoped/pkg'
      const version = '1.0.0'

      const scopedPackagePayload = {
        ...packagePublishPayload,
        _id: fullName,
        name: fullName,
        versions: {
          [version]: {
            ...packagePublishPayload.versions['1.0.0'],
            _id: `${fullName}@${version}`,
            name: fullName,
            dist: {
              ...packagePublishPayload.versions['1.0.0'].dist,
              tarball: tarballUrl(fullName, version),
            },
          },
        },
        _attachments: {
          [attachmentTarballName(fullName, version)]: packagePublishPayload._attachments['mock-1.0.0.tgz'],
        },
      }

      const { token: adminToken } = await createToken({
        name: 'admin',
        scopes: [{ type: 'package:read+write', values: ['*'] }],
      })

      const publishResponse = await SELF.fetch(`http://localhost/${fullName}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify(scopedPackagePayload),
      })
      expect(publishResponse.status).toBe(200)

      const { token: userToken } = await createToken({
        name: 'user',
        scopes: [{ type: 'package:read', values: ['something-else'] }],
      })

      const response = await SELF.fetch(`http://localhost/${fullName}`, {
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      })

      expect(response.status).toBe(403)
    })

    it('should allow access if token has access to scoped package in local registry', async () => {
      const fullName = '@scoped/pkg-ok'
      const version = '1.0.0'

      const scopedPackagePayload = {
        ...packagePublishPayload,
        _id: fullName,
        name: fullName,
        versions: {
          [version]: {
            ...packagePublishPayload.versions['1.0.0'],
            _id: `${fullName}@${version}`,
            name: fullName,
            dist: {
              ...packagePublishPayload.versions['1.0.0'].dist,
              tarball: tarballUrl(fullName, version),
            },
          },
        },
        _attachments: {
          [attachmentTarballName(fullName, version)]: packagePublishPayload._attachments['mock-1.0.0.tgz'],
        },
      }

      const { token: adminToken } = await createToken({
        name: 'admin',
        scopes: [{ type: 'package:read+write', values: ['*'] }],
      })

      const publishResponse = await SELF.fetch(`http://localhost/${fullName}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify(scopedPackagePayload),
      })
      expect(publishResponse.status).toBe(200)

      const { token: userToken } = await createToken({
        name: 'user',
        scopes: [{ type: 'package:read', values: [fullName] }],
      })

      const response = await SELF.fetch(`http://localhost/${fullName}`, {
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      })

      expect(response.status).toBe(200)
      const body = (await response.json()) as { name: string } | undefined
      if (!body) return
      expect(body.name).toBe(fullName)
    })
  })

  describe('GET /:packageScope/:packageName/-/:tarballName', () => {
    it('should allow downloading a scoped package tarball', async () => {
      const fullName = '@scoped/pkg-tarball'
      const version = '1.0.0'
      const publicName = publicTarballName(fullName, version)

      const scopedPackagePayload = {
        ...packagePublishPayload,
        _id: fullName,
        name: fullName,
        versions: {
          [version]: {
            ...packagePublishPayload.versions['1.0.0'],
            _id: `${fullName}@${version}`,
            name: fullName,
            dist: {
              ...packagePublishPayload.versions['1.0.0'].dist,
              tarball: tarballUrl(fullName, version),
            },
          },
        },
        _attachments: {
          [attachmentTarballName(fullName, version)]: packagePublishPayload._attachments['mock-1.0.0.tgz'],
        },
      }

      const { token: adminToken } = await createToken({
        name: 'admin',
        scopes: [{ type: 'package:read+write', values: ['*'] }],
      })

      const publishResponse = await SELF.fetch(`http://localhost/${fullName}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify(scopedPackagePayload),
      })
      expect(publishResponse.status).toBe(200)

      const { token: userToken } = await createToken({
        name: 'user',
        scopes: [{ type: 'package:read', values: [fullName] }],
      })

      const response = await SELF.fetch(`http://localhost/${fullName}/-/${publicName}`, {
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      })

      expect(response.status).toBe(200)
      const blob = await response.blob()
      expect(blob.size).toBeGreaterThan(0)
    })
  })

  describe('403 Forbidden scenarios', () => {
    it('should match scoped package with @scope/* glob', async () => {
      const { token } = await createToken({
        name: 'test-token',
        scopes: [{ type: 'package:read+write', values: ['@babadeluxe/*'] }],
      })

      const fullName = '@babadeluxe/xo-config'
      const version = '1.0.0'

      const scopedPackagePayload = {
        ...packagePublishPayload,
        _id: fullName,
        name: fullName,
        versions: {
          [version]: {
            ...packagePublishPayload.versions['1.0.0'],
            _id: `${fullName}@${version}`,
            name: fullName,
            dist: {
              ...packagePublishPayload.versions['1.0.0'].dist,
              tarball: tarballUrl(fullName, version),
            },
          },
        },
        _attachments: {
          [attachmentTarballName(fullName, version)]: packagePublishPayload._attachments['mock-1.0.0.tgz'],
        },
      }

      const response = await SELF.fetch(`http://localhost/${fullName}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(scopedPackagePayload),
      })

      expect(response.status).toBe(200)
    })

    it('should match scoped package with @scope** glob when slashes are allowed to cross', async () => {
      const { token } = await createToken({
        name: 'test-token',
        scopes: [{ type: 'package:read+write', values: ['@babadeluxe**'] }],
      })

      const fullName = '@babadeluxe/xo-config'
      const version = '1.0.0'

      const scopedPackagePayload = {
        ...packagePublishPayload,
        _id: fullName,
        name: fullName,
        versions: {
          [version]: {
            ...packagePublishPayload.versions['1.0.0'],
            _id: `${fullName}@${version}`,
            name: fullName,
            dist: {
              ...packagePublishPayload.versions['1.0.0'].dist,
              tarball: tarballUrl(fullName, version),
            },
          },
        },
        _attachments: {
          [attachmentTarballName(fullName, version)]: packagePublishPayload._attachments['mock-1.0.0.tgz'],
        },
      }

      const response = await SELF.fetch(`http://localhost/${fullName}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(scopedPackagePayload),
      })

      expect(response.status).toBe(200)
    })
  })
})
