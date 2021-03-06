import log from 'loglevel'
import winston, { transport } from 'winston'
import { HttpTransportOptions } from 'winston/lib/winston/transports'

import { NpmLogLevel } from './types/Aliases'
import { gsnRuntimeVersion } from '../common/Version'
import { LoggerInterface } from '../common/LoggerInterface'

const format = winston.format.combine(
  winston.format.uncolorize(),
  winston.format.timestamp(),
  winston.format.simple()
)

const service = 'gsn-client'
const userIdKey = 'gsnuser'

const isBrowser = typeof window !== 'undefined'

function getOrCreateUserId (): string {
  let userId = window.localStorage[userIdKey]
  if (userId == null) {
    userId = `${userIdKey}${Date.now() % 1000000}`
    window.localStorage[userIdKey] = userId
  }
  return userId
}

export function createClientLogger (level: NpmLogLevel, loggerUrl: string, applicationId: string, userIdOverride: string): LoggerInterface {
  if (loggerUrl.length === 0 || typeof window === 'undefined' || window.localStorage == null) {
    log.setLevel(level)
    return log
  }

  const url = new URL(loggerUrl)
  const host = url.host
  const path = url.pathname
  const ssl = url.protocol === 'https:'
  const headers = { 'content-type': 'text/plain' }
  const httpTransportOptions: HttpTransportOptions = {
    ssl,
    format,
    host,
    path,
    headers
  }

  const transports: transport[] = [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.Http(httpTransportOptions)
  ]
  let userId: string
  if (userIdOverride.length !== 0) {
    userId = userIdOverride
  } else {
    userId = getOrCreateUserId()
  }

  const localhostRegExp: RegExp = /http:\/\/(localhost)|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/
  if (applicationId.length === 0 && typeof window !== 'undefined' && window.location != null && window.location.href != null && window.location.href.match(localhostRegExp) == null) {
    applicationId = window.location.href
  }
  const logger = winston.createLogger({
    level,
    defaultMeta: {
      version: gsnRuntimeVersion,
      service,
      isBrowser,
      applicationId,
      userId
    },
    transports
  })
  logger.debug(`Created remote logs collecting logger for userId: ${userId} and applicationId: ${applicationId}`)
  if (applicationId.length === 0) {
    logger.warn('application ID is not set!')
  }
  return logger
}
