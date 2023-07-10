// @ts-check
import { readFile } from 'fs/promises'
import { EOL } from 'os'
import path, { join } from 'path'
import process from 'process'

import { getFramework, getSettings } from '@netlify/build-info'
import fuzzy from 'fuzzy'
import getPort from 'get-port'

import { NETLIFYDEVWARN, chalk, log } from './command-helpers.mjs'
import { acquirePort } from './dev.mjs'
import { getInternalFunctionsDir } from './functions/functions.mjs'

/** @param {string} str */
const formatProperty = (str) => chalk.magenta(`'${str}'`)
/** @param {string} str */
const formatValue = (str) => chalk.green(`'${str}'`)

/**
 * @param {object} options
 * @param {string} options.keyFile
 * @param {string} options.certFile
 * @returns {Promise<{ key: string, cert: string, keyFilePath: string, certFilePath: string }>}
 */
const readHttpsSettings = async (options) => {
  if (typeof options !== 'object' || !options.keyFile || !options.certFile) {
    throw new TypeError(
      `https options should be an object with ${formatProperty('keyFile')} and ${formatProperty(
        'certFile',
      )} string properties`,
    )
  }

  const { certFile, keyFile } = options
  if (typeof keyFile !== 'string') {
    throw new TypeError(`Private key file configuration should be a string`)
  }
  if (typeof certFile !== 'string') {
    throw new TypeError(`Certificate file configuration should be a string`)
  }

  const [{ reason: keyError, value: key }, { reason: certError, value: cert }] = await Promise.allSettled([
    readFile(keyFile, 'utf-8'),
    readFile(certFile, 'utf-8'),
  ])

  if (keyError) {
    throw new Error(`Error reading private key file: ${keyError.message}`)
  }
  if (certError) {
    throw new Error(`Error reading certificate file: ${certError.message}`)
  }

  return { key, cert, keyFilePath: path.resolve(keyFile), certFilePath: path.resolve(certFile) }
}

/**
 * @param {object} config
 * @param {import('../commands/dev/types.js').DevConfig} config.devConfig
 * @param {keyof import('../commands/dev/types.js').DevConfig} config.property
 */
const validateStringProperty = ({ devConfig, property }) => {
  if (devConfig[property] && typeof devConfig[property] !== 'string') {
    const formattedProperty = formatProperty(property)
    throw new TypeError(
      `Invalid ${formattedProperty} option provided in config. The value of ${formattedProperty} option must be a string`,
    )
  }
}

/**
 * @param {object} config
 * @param {import('../commands/dev/types.js').DevConfig} config.devConfig
 * @param {keyof import('../commands/dev/types.js').DevConfig} config.property
 */
const validateNumberProperty = ({ devConfig, property }) => {
  if (devConfig[property] && typeof devConfig[property] !== 'number') {
    const formattedProperty = formatProperty(property)
    throw new TypeError(
      `Invalid ${formattedProperty} option provided in config. The value of ${formattedProperty} option must be an integer`,
    )
  }
}

/**
 *
 * @param {object} config
 * @param {import('../commands/dev/types.js').DevConfig} config.devConfig
 */
const validateFrameworkConfig = ({ devConfig }) => {
  validateStringProperty({ devConfig, property: 'command' })
  validateNumberProperty({ devConfig, property: 'port' })
  validateNumberProperty({ devConfig, property: 'targetPort' })

  if (devConfig.targetPort && devConfig.targetPort === devConfig.port) {
    throw new Error(
      `${formatProperty('port')} and ${formatProperty(
        'targetPort',
      )} options cannot have same values. Please consult the documentation for more details: https://cli.netlify.com/netlify-dev#netlifytoml-dev-block`,
    )
  }
}

/**
 * @param {object} config
 * @param {import('../commands/dev/types.js').DevConfig} config.devConfig
 * @param {number=} config.detectedPort
 */
const validateConfiguredPort = ({ detectedPort, devConfig }) => {
  if (devConfig.port && devConfig.port === detectedPort) {
    const formattedPort = formatProperty('port')
    throw new Error(
      `The ${formattedPort} option you specified conflicts with the port of your application. Please use a different value for ${formattedPort}`,
    )
  }
}

const DEFAULT_PORT = 8888
const DEFAULT_STATIC_PORT = 3999

const getDefaultDist = () => {
  log(`${NETLIFYDEVWARN} Unable to determine public folder to serve files from. Using current working directory`)
  log(`${NETLIFYDEVWARN} Setup a netlify.toml file with a [dev] section to specify your dev server settings.`)
  log(`${NETLIFYDEVWARN} See docs at: https://cli.netlify.com/netlify-dev#project-detection`)
  return process.cwd()
}

/**
 * @param {object} config
 * @param {import('../commands/dev/types.js').DevConfig} config.devConfig
 * @returns {Promise<number>}
 */
const getStaticServerPort = async ({ devConfig }) => {
  const port = await acquirePort({
    configuredPort: devConfig.staticServerPort,
    defaultPort: DEFAULT_STATIC_PORT,
    errorMessage: 'Could not acquire configured static server port',
  })

  return port
}

/**
 *
 * @param {object} config
 * @param {import('../commands/dev/types.js').DevConfig} config.devConfig
 * @param {import('commander').OptionValues} config.options
 * @param {string} config.projectDir
 * @returns {Promise<import('./types.js').BaseServerSettings>}
 */
const handleStaticServer = async ({ devConfig, options, projectDir }) => {
  validateNumberProperty({ devConfig, property: 'staticServerPort' })

  if (options.dir) {
    log(`${NETLIFYDEVWARN} Using simple static server because ${formatProperty('--dir')} flag was specified`)
  } else if (devConfig.framework === '#static') {
    log(
      `${NETLIFYDEVWARN} Using simple static server because ${formatProperty(
        '[dev.framework]',
      )} was set to ${formatValue('#static')}`,
    )
  }

  if (devConfig.targetPort) {
    log(
      `${NETLIFYDEVWARN} Ignoring ${formatProperty(
        'targetPort',
      )} setting since using a simple static server.${EOL}${NETLIFYDEVWARN} Use --staticServerPort or [dev.staticServerPort] to configure the static server port`,
    )
  }

  const dist = options.dir || devConfig.publish || getDefaultDist()
  log(`${NETLIFYDEVWARN} Running static server from "${path.relative(path.dirname(projectDir), dist)}"`)

  const frameworkPort = await getStaticServerPort({ devConfig })
  return {
    ...(devConfig.command && { command: devConfig.command }),
    useStaticServer: true,
    frameworkPort,
    dist,
  }
}

// these plugins represent runtimes that are
// expected to be "automatically" installed. Even though
// they can be installed on package/toml, we always
// want them installed in the site settings. When installed
// there our build will automatically install the latest without
// user management of the versioning.
const pluginsToAlwaysInstall = new Set(['@netlify/plugin-nextjs'])

/**
 * Retrieve a list of plugins to auto install
 * @param {string[]=} pluginsInstalled
 * @param {string[]=} pluginsRecommended
 * @returns
 */
const getPluginsToAutoInstall = (pluginsInstalled = [], pluginsRecommended = []) =>
  pluginsRecommended.reduce(
    (acc, plugin) =>
      pluginsInstalled.includes(plugin) && !pluginsToAlwaysInstall.has(plugin) ? acc : [...acc, plugin],
    // eslint-disable-next-line no-inline-comments
    /** @type {string[]} */ ([]),
  )

/**
 * Retrieves the settings from a framework
 * @param {import('@netlify/build-info').Settings} settings
 * @returns {import('./types.js').BaseServerSettings}
 */
const getSettingsFromDetectedSettings = (settings) => {
  const {
    devCommand: command,
    dist,
    env,
    framework: { name: frameworkName },
    frameworkPort,
    // eslint-disable-next-line camelcase
    plugins_from_config_file,
    // eslint-disable-next-line camelcase
    plugins_recommended,
    pollingStrategies,
  } = settings

  return {
    command,
    frameworkPort,
    dist,
    framework: frameworkName,
    env,
    pollingStrategies,
    plugins: getPluginsToAutoInstall(plugins_from_config_file, plugins_recommended),
  }
}

/**
 * @param {import('@netlify/build-info').Project} project
 */
const detectFrameworkSettings = async (project) => {
  const projectSettings = await project.getBuildSettings()
  const settings = projectSettings
    .filter((setting) =>
      project.workspace && !project.workspace.isRoot
        ? process.cwd().startsWith(join(project.jsWorkspaceRoot, setting.packagePath ?? ''))
        : true,
    )
    .filter((setting) => setting.devCommand)

  if (settings.length === 1) {
    return getSettingsFromDetectedSettings(settings[0])
  }

  if (settings.length > 1) {
    // performance optimization, load inquirer on demand
    const { default: inquirer } = await import('inquirer')
    const { default: inquirerAutocompletePrompt } = await import('inquirer-autocomplete-prompt')
    /** multiple matching detectors, make the user choose */
    inquirer.registerPrompt('autocomplete', inquirerAutocompletePrompt)
    const scriptInquirerOptions = formatSettingsArrForInquirer(settings)
    const { chosenSettings } = await inquirer.prompt({
      name: 'chosenSettings',
      message: `Multiple possible start commands found`,
      type: 'autocomplete',
      source(_, input) {
        if (!input || input === '') {
          return scriptInquirerOptions
        }
        // only show filtered results
        return filterSettings(scriptInquirerOptions, input)
      },
    })
    log(
      `Add ${formatProperty(
        `framework = "${chosenSettings.framework.id}"`,
      )} to the [dev] section of your netlify.toml to avoid this selection prompt next time`,
    )

    return getSettingsFromDetectedSettings(chosenSettings)
  }
}

/**
 * @param {object} config
 * @param {import('../commands/dev/types.js').DevConfig} config.devConfig
 */
const hasCommandAndTargetPort = ({ devConfig }) => devConfig.command && devConfig.targetPort

/**
 * Creates settings for the custom framework
 * @param {object} config
 * @param {import('../commands/dev/types.js').DevConfig} config.devConfig
 * @returns {import('./types.js').BaseServerSettings}
 */
const handleCustomFramework = ({ devConfig }) => {
  if (!hasCommandAndTargetPort({ devConfig })) {
    throw new Error(
      `${formatProperty('command')} and ${formatProperty('targetPort')} properties are required when ${formatProperty(
        'framework',
      )} is set to ${formatValue('#custom')}`,
    )
  }
  return {
    command: devConfig.command,
    frameworkPort: devConfig.targetPort,
    dist: devConfig.publish || getDefaultDist(),
    framework: '#custom',
    pollingStrategies: devConfig.pollingStrategies || [],
  }
}

/**
 * @param {{ devConfig: any, frameworkSettings: import('./types.js').BaseServerSettings }} param0
 */
const mergeSettings = async ({ devConfig, frameworkSettings = {} }) => {
  const {
    command: frameworkCommand,
    dist,
    env,
    framework,
    frameworkPort: frameworkDetectedPort,
    pollingStrategies = [],
  } = frameworkSettings

  const command = devConfig.command || frameworkCommand
  const frameworkPort = devConfig.targetPort || frameworkDetectedPort
  // if the framework doesn't start a server, we use a static one
  const useStaticServer = !(command && frameworkPort)
  return {
    command,
    frameworkPort: useStaticServer ? await getStaticServerPort({ devConfig }) : frameworkPort,
    dist: devConfig.publish || dist || getDefaultDist(),
    framework,
    env,
    pollingStrategies,
    useStaticServer,
  }
}

/**
 * Handles a forced framework and retrieves the settings for it
 * @param {{ devConfig: any, project: import('@netlify/build-info').Project }} config
 * @returns {Promise<import('./types.js').BaseServerSettings>}
 */
const handleForcedFramework = async ({ devConfig, project }) => {
  // this throws if `devConfig.framework` is not a supported framework
  const framework = await getFramework(devConfig.framework, project)
  const settings = await getSettings(framework, project, '')
  const frameworkSettings = getSettingsFromDetectedSettings(settings)
  return mergeSettings({ devConfig, frameworkSettings })
}

/**
 * Get the server settings based on the flags and the devConfig
 * @param {import('../commands/dev/types.js').DevConfig} devConfig
 * @param {import('commander').OptionValues} options
 * @param {import('@netlify/build-info').Project} project
 * @param {string} projectDir
 * @returns {Promise<import('./types.js').ServerSettings>}
 */

const detectServerSettings = async (devConfig, options, project, projectDir) => {
  validateStringProperty({ devConfig, property: 'framework' })

  /** @type {Partial<import('./types.js').BaseServerSettings>} */
  let settings = {}

  if (options.dir || devConfig.framework === '#static') {
    // serving files statically without a framework server
    settings = await handleStaticServer({ options, devConfig, projectDir })
  } else if (devConfig.framework === '#auto') {
    // this is the default CLI behavior

    const runDetection = !hasCommandAndTargetPort({ devConfig })
    const frameworkSettings = runDetection ? await detectFrameworkSettings(project) : undefined

    if (frameworkSettings === undefined) {
      log(`${NETLIFYDEVWARN} No app server detected. Using simple static server`)
      settings = await handleStaticServer({ options, devConfig, projectDir })
    } else {
      validateFrameworkConfig({ devConfig })
      settings = await mergeSettings({ devConfig, frameworkSettings })
    }

    settings.plugins = frameworkSettings && frameworkSettings.plugins
  } else if (devConfig.framework === '#custom') {
    validateFrameworkConfig({ devConfig })
    // when the users wants to configure `command` and `targetPort`
    settings = handleCustomFramework({ devConfig })
  } else if (devConfig.framework) {
    validateFrameworkConfig({ devConfig })
    // this is when the user explicitly configures a framework, e.g. `framework = "gatsby"`
    settings = await handleForcedFramework({ devConfig, project })
  }

  validateConfiguredPort({ devConfig, detectedPort: settings.frameworkPort })

  const acquiredPort = await acquirePort({
    configuredPort: devConfig.port,
    defaultPort: DEFAULT_PORT,
    errorMessage: `Could not acquire required ${formatProperty('port')}`,
  })
  const functionsDir = devConfig.functions || settings.functions
  const internalFunctionsDir = await getInternalFunctionsDir({ base: projectDir })
  const shouldStartFunctionsServer = Boolean(functionsDir || internalFunctionsDir)

  return {
    ...settings,
    port: acquiredPort,
    jwtSecret: devConfig.jwtSecret || 'secret',
    jwtRolePath: devConfig.jwtRolePath || 'app_metadata.authorization.roles',
    functions: functionsDir,
    ...(shouldStartFunctionsServer && { functionsPort: await getPort({ port: devConfig.functionsPort || 0 }) }),
    ...(devConfig.https && { https: await readHttpsSettings(devConfig.https) }),
  }
}

const filterSettings = function (scriptInquirerOptions, input) {
  const filterOptions = scriptInquirerOptions.map((scriptInquirerOption) => scriptInquirerOption.name)
  // TODO: remove once https://github.com/sindresorhus/eslint-plugin-unicorn/issues/1394 is fixed
  // eslint-disable-next-line unicorn/no-array-method-this-argument
  const filteredSettings = fuzzy.filter(input, filterOptions)
  const filteredSettingNames = new Set(
    filteredSettings.map((filteredSetting) => (input ? filteredSetting.string : filteredSetting)),
  )
  return scriptInquirerOptions.filter((t) => filteredSettingNames.has(t.name))
}

/**
 * @param {import('@netlify/build-info').Settings[]} settings
 * @returns
 */
const formatSettingsArrForInquirer = function (settings) {
  return settings.map((setting) => ({
    name: `[${chalk.yellow(setting.framework.name)}] '${setting.devCommand}'`,
    value: { ...setting, commands: [setting.devCommand] },
    short: `${setting.name}-${setting.devCommand}`,
  }))
}

/**
 * Returns a copy of the provided config with any plugins provided by the
 * server settings
 * @param {*} config
 * @param {Partial<import('./types.js').ServerSettings>} settings
 * @returns {*} Modified config
 */
export const getConfigWithPlugins = (config, settings) => {
  if (!settings.plugins) {
    return config
  }

  // If there are plugins that we should be running for this site, add them
  // to the config as if they were declared in netlify.toml. We must check
  // whether the plugin has already been added by another source (like the
  // TOML file or the UI), as we don't want to run the same plugin twice.
  const { plugins: existingPlugins = [] } = config
  const existingPluginNames = new Set(existingPlugins.map((plugin) => plugin.package))
  const newPlugins = settings.plugins
    .map((pluginName) => {
      if (existingPluginNames.has(pluginName)) {
        return
      }

      return { package: pluginName, origin: 'config', inputs: {} }
    })
    .filter(Boolean)

  return {
    ...config,
    plugins: [...newPlugins, ...config.plugins],
  }
}

export default detectServerSettings
