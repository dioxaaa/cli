import { env as _env, version as nodejsVersion } from 'process'

import type { Options } from 'execa'
import execa from 'execa'
import { version as uuidVersion } from 'uuid'
import { beforeEach, expect, test, afterEach, beforeAll, describe } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../mswServer.ts'

import { name, version } from '../../package.json'

import { callCli } from './utils/call-cli.mjs'
import { cliPath } from './utils/cli-path.mjs'
import { MockApiTestContext, withMockApi } from './utils/mock-api-vitest.js'
import { withSiteBuilder } from './utils/site-builder.mjs'

const getCLIOptions = (apiUrl): Options => ({
  env: {
    NETLIFY_TEST_TRACK_URL: `${apiUrl}/track`,
    NETLIFY_TEST_IDENTIFY_URL: `${apiUrl}/identify`,
    NETLIFY_TEST_TELEMETRY_WAIT: 'true',
    NETLIFY_API_URL: apiUrl,
    PATH: _env.PATH,
    HOME: _env.HOME,
    APPDATA: _env.APPDATA,
  },
  extendEnv: false,
})

const routes = [
  { path: 'track', method: 'POST', response: {} },
  { path: 'sites', response: [] },
  { path: 'accounts', response: [] },
]

describe('telemetry', async () => {
  let requestMade
  let unhandledRequestMade = false
  let unhandledRequest = {
    url: '',
    method: ''
  }

  beforeEach(() => {
    requestMade = undefined
    unhandledRequestMade = false
    unhandledRequest = {
      method: '',
      url: ''
    }

    server.use(
      http.post(`*`, ({ request }) => {
        unhandledRequestMade = true
        unhandledRequest = {
          url: request.url,
          method: request.method,
        }
        return HttpResponse.json({}, { status: 500 })
      })
    )

    server.use(
      http.post(`http://localhost/api/v1/track`, ({request}) => {
        requestMade = request
        return HttpResponse.json({}, { status: 200 })
      })
    )
  })

  afterEach(() => {
    if (unhandledRequestMade) {
      throw new Error(`Unhandled request was made: ${JSON.stringify(unhandledRequest)}}`)
    }
    server.resetHandlers()
  })

  await withMockApi(routes, async () => {
    test<MockApiTestContext>('should not track --telemetry-disable', async ({ apiUrl }) => {
      await callCli(['--telemetry-disable'], getCLIOptions(apiUrl))
      expect(requestMade).toBeUndefined()
    })

    test<MockApiTestContext>('should track --telemetry-enable', async ({ apiUrl }) => {
      const UUID_VERSION = 4

      await callCli(['--telemetry-enable'], getCLIOptions(apiUrl))

      expect(requestMade).toBeDefined()
      expect(requestMade.method).toEqual('POST')
      expect(requestMade.headers.get('user-agent')).toEqual(`${name}/${version}`)

      const body = await requestMade.json()

      expect(body.event).toEqual('cli:user_telemetryEnabled')
      expect(uuidVersion(body.anonymousId)).toEqual(UUID_VERSION)
      expect(body.properties).toStrictEqual({ cliVersion: version, nodejsVersion })
    })

    test<MockApiTestContext>('should send netlify-cli/<version> user-agent', async ({ apiUrl }) => {
      server.use(
        http.get(`http://localhost/api/v1/accounts`, () => {
          return HttpResponse.json({}, { status: 200 })
        })
      )
      server.use(
        http.get(`http://localhost/api/v1/sites`, () => {
          return HttpResponse.json({}, { status: 200 })
        })
      )
  
      await callCli(['api', 'listSites'], getCLIOptions(apiUrl))
      
      expect(requestMade).toBeDefined()
      // example: netlify-cli/6.14.25 darwin-x64 node-v16.13.0
      const userAgent = requestMade.headers.get('user-agent')
      expect(userAgent.startsWith(`${name}/${version}`)).toEqual(true)
    })
  })
})


//   test<MockApiTestContext>('should send correct command on success', async ({ apiUrl, requests }) => {
//     await callCli(['api', 'listSites'], getCLIOptions(apiUrl))
//     const request = requests.find(({ path }) => path === '/api/v1/track')
//     expect(request).toBeDefined()

//     expect(typeof request.body.anonymousId).toBe('string')
//     expect(Number.isInteger(request.body.duration)).toBe(true)
//     expect(request.body.event).toBe('cli:command')
//     expect(request.body.status).toBe('success')
//     expect(request.body.properties).toEqual({
//       buildSystem: [],
//       cliVersion: version,
//       command: 'api',
//       monorepo: false,
//       nodejsVersion,
//       packageManager: 'npm',
//     })
//   })

//   test<MockApiTestContext>('should send correct command on failure', async ({ apiUrl, requests }) => {
//     await expect(callCli(['dev:exec', 'exit 1'], getCLIOptions(apiUrl))).rejects.toThrowError()
//     const request = requests.find(({ path }) => path === '/api/v1/track')
//     expect(request).toBeDefined()

//     expect(typeof request.body.anonymousId).toBe('string')
//     expect(Number.isInteger(request.body.duration)).toBe(true)
//     expect(request.body.event).toBe('cli:command')
//     expect(request.body.status).toBe('error')
//     expect(request.body.properties).toEqual({
//       buildSystem: [],
//       cliVersion: version,
//       command: 'dev:exec',
//       monorepo: false,
//       nodejsVersion,
//       packageManager: 'npm',
//     })
//   })

//   test('should add frameworks, buildSystem, and packageManager', async ({ apiUrl, requests }) => {
//     await withSiteBuilder('nextjs-site', async (builder) => {
//       await builder.withPackageJson({ packageJson: { dependencies: { next: '^12.13.0' } } }).buildAsync()

//       await execa(cliPath, ['api', 'listSites'], {
//         cwd: builder.directory,
//         ...getCLIOptions(apiUrl),
//       })

//       const request = requests.find(({ path }) => path === '/api/v1/track')
//       expect(request).toBeDefined()

//       expect(typeof request.body.anonymousId).toBe('string')
//       expect(Number.isInteger(request.body.duration)).toBe(true)
//       expect(request.body.event).toBe('cli:command')
//       expect(request.body.status).toBe('success')
//       expect(request.body.properties).toEqual({
//         frameworks: ['next'],
//         buildSystem: [],
//         cliVersion: version,
//         command: 'api',
//         monorepo: false,
//         nodejsVersion,
//         packageManager: 'npm',
//       })
//     })
//   })
// })
