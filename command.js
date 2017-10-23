#!/usr/bin/env node

const dashdash = require("dashdash")
const path = require("path")
const fs = require("fs-extra")
const each = require("lodash/each")
const keys = require("lodash/fp/keys")
const map = require("lodash/fp/map")
const NodeRSA = require("node-rsa")
const Compose = require("./lib/compose")
const Environment = require("./lib/environment")
const Bootstrap = require("./lib/bootstrap")
const parseEnv = require("./lib/helpers/parse-env-file")
const { jsonToEnv } = require("./lib/helpers/environment-helper")

class Command {
  parseOptions() {
    const options = [
      {
        names: ["help", "h"],
        type: "bool",
        help: "Print this help and exit.",
      },
      {
        names: ["init"],
        type: "bool",
        help: "Generate defaults json file",
      },
      {
        names: ["bootstrap", "b"],
        type: "bool",
        help: "Generate application devices and environment",
      },
      {
        names: ["defaults", "d"],
        type: "string",
        completionType: "filename",
        help: "A .json, or .env file containing the default environment variables",
      },
      {
        names: ["private-key"],
        type: "string",
        completionType: "filename",
        help: "Private Key PEM file (PKCS8)",
      },
      {
        names: ["public-key"],
        type: "string",
        completionType: "filename",
        help: "Public Key PEM file (PKCS8)",
      },
      {
        names: ["output", "o"],
        type: "string",
        help: "Output directory for Octoblu stack files",
      },
      {
        names: ["stack", "s"],
        type: "arrayOfString",
        help: "The stack to run, to have multiple stacks use multiple --stack arguments",
        default: ["meshblu-core"],
      },
      {
        names: ["stacks-dir"],
        type: "string",
        completionType: "filename",
        help: "Stacks directory",
        default: path.join(__dirname, "stacks"),
      },
      {
        names: ["templates-dir"],
        type: "string",
        completionType: "filename",
        help: "Template directory",
        default: path.join(__dirname, "templates"),
      },
    ]

    this.parser = dashdash.createParser({ options: options })
    const opts = this.parser.parse(process.argv)

    if (opts.help) {
      const help = this.parser.help({ includeEnv: true, includeDefaults: true }).trimRight()
      console.error("usage: octoblu-stack-generator [OPTIONS]\n" + "options:\n" + help)
      process.exit(0)
    }
    return opts
  }

  run() {
    const {
      init,
      bootstrap,
      output,
      defaults,
      stack,
      stacks_dir,
      templates_dir,
      private_key,
      public_key,
    } = this.parseOptions()
    const stacks = stack
    const privateKey = private_key
    const publicKey = public_key
    if (!output) {
      const help = this.parser.help({ includeEnv: true, includeDefaults: true }).trimRight()
      console.error("usage: octoblu-stack-generator [OPTIONS]\n" + "options:\n" + help)
      console.error("\noctoblu-stack-generator requires --output, -o option")
      process.exit(1)
    }

    const templatesDir = templates_dir
    const outputDirectory = path.resolve(output)
    const defaultsFilePath = defaults ? path.resolve(defaults) : path.join(outputDirectory, "defaults.env")
    const privateKeyFilePath = privateKey ? path.resolve(privateKey) : path.join(outputDirectory, "privateKey.pem")
    const publicKeyFilePath = publicKey ? path.resolve(publicKey) : path.join(outputDirectory, "publicKey.pem")

    const absoluteStacksDir = path.isAbsolute(stacks_dir) ? stacks_dir : path.join(process.cwd(), stacks_dir)
    const stackPaths = map(filePath => `${path.join(absoluteStacksDir, filePath)}.yml`, stacks)
    const compose = Compose.fromYAMLFilesSync(stackPaths)
    const services = keys(compose.toObject().services)

    if (init)
      return this.init({
        outputDirectory,
        init,
        defaultsFilePath,
        publicKeyFilePath,
        privateKeyFilePath,
        services,
        templatesDir,
      })
    if (bootstrap)
      return this.bootstrap({
        outputDirectory,
        init,
        defaultsFilePath,
        publicKeyFilePath,
        privateKeyFilePath,
        services,
        templatesDir,
      })

    if (!fs.existsSync(defaultsFilePath)) {
      console.error(`Defaults file ${defaultsFilePath} not found.`)
      console.error("Generate a defaults file by running this command with --init.")
      process.exit(1)
    }
    compose.toYAMLFileSync(path.join(outputDirectory, "docker-compose.yml"))
    this.environment({ services, defaultsFilePath, outputDirectory, templatesDir })
  }

  init({ services, outputDirectory, defaultsFilePath, privateKeyFilePath, publicKeyFilePath, templatesDir }) {
    fs.ensureDirSync(outputDirectory)
    const environment = new Environment({ services, templatesDir })
    if (!fs.existsSync(privateKeyFilePath) && !fs.existsSync(publicKeyFilePath)) {
      const key = new NodeRSA()
      key.generateKeyPair(1024)
      const privateKey = key.exportKey("private")
      const publicKey = key.exportKey("public")
      fs.writeFileSync(privateKeyFilePath, privateKey)
      fs.writeFileSync(publicKeyFilePath, publicKey)
    }
    console.log(`${defaultsFilePath} created`)
    console.log("Add your defaults now and run again without --init")
    let existingDefaults = {}
    if (fs.existsSync(defaultsFilePath)) {
      existingDefaults = parseEnv(fs.readFileSync(defaultsFilePath))
    }
    if (path.extname(defaultsFilePath) === ".env") {
      fs.writeFileSync(defaultsFilePath, jsonToEnv(environment.merge(existingDefaults)))
      return
    }
    fs.writeJSONSync(defaultsFilePath, environment.merge(existingDefaults), { spaces: 2 })
  }

  async bootstrap({ services, defaultsFilePath, templatesDir }) {
    let env
    if (path.extname(defaultsFilePath) === ".env") {
      env = parseEnv(fs.readFileSync(defaultsFilePath, "utf8"))
    } else {
      env = fs.readJSONSync(defaultsFilePath)
    }
    const bootstrap = new Bootstrap({ services, templatesDir, env })
    const result = await bootstrap.run()
    console.log(result)
  }

  compose({ services, outputDirectory, templatesDir }) {
    const compose = new Compose({ services, templatesDir })
    fs.ensureDirSync(outputDirectory)
    fs.writeFileSync(path.join(outputDirectory, "docker-compose.yml"), compose.toYAML())
  }

  environment({ services, defaultsFilePath, outputDirectory, templatesDir }) {
    let values
    if (path.extname(defaultsFilePath) === ".env") {
      values = parseEnv(fs.readFileSync(defaultsFilePath, "utf8"))
    } else {
      values = fs.readJSONSync(defaultsFilePath)
    }
    const environment = new Environment({ services, values, templatesDir })
    const envDir = path.join(outputDirectory, "env.d")
    fs.ensureDirSync(envDir)
    each(environment.toJSON(), (serviceEnv, serviceName) => {
      fs.writeFileSync(path.join(envDir, serviceName + ".env"), jsonToEnv(serviceEnv))
    })
  }
}

if (require.main === module) {
  const command = new Command()
  command.run()
} else {
  module.exports = Command
}
