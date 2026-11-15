import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from '../config.js'

export type RegistrationStatus = 'pending' | 'approved' | 'rejected'

export type RegistrationRequest = {
  id: string
  status: RegistrationStatus
  contactName: string
  workEmail: string
  companyName: string
  companyWebsite: string
  jobTitle: string
  phone: string
  companySize: string
  useCase: string
  passwordHash: string
  createdAt: string
  updatedAt: string
  reviewedAt?: string
  reviewedBy?: string
  rejectReason?: string
  userId?: string
  mailSent: boolean
  mailError?: string
}

const STORE_PATH = path.join(config.dataDir, 'registration-requests.json')

function readAll(): RegistrationRequest[] {
  if (!fs.existsSync(STORE_PATH)) return []
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as RegistrationRequest[]
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function writeAll(list: RegistrationRequest[]) {
  fs.mkdirSync(config.dataDir, { recursive: true })
  fs.writeFileSync(STORE_PATH, JSON.stringify(list, null, 2), 'utf8')
}

export function listRegistrationRequests(status?: RegistrationStatus) {
  const all = readAll().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  if (!status) return all
  return all.filter((r) => r.status === status)
}

export function findRegistrationById(id: string) {
  return readAll().find((r) => r.id === id) || null
}

export function findRegistrationByEmail(email: string) {
  const normalized = email.trim().toLowerCase()
  return readAll().find((r) => r.workEmail === normalized) || null
}

export function createRegistrationRequest(
  input: Omit<
    RegistrationRequest,
    'id' | 'status' | 'createdAt' | 'updatedAt' | 'mailSent' | 'mailError'
  > & { mailSent?: boolean; mailError?: string },
): RegistrationRequest {
  const now = new Date().toISOString()
  const row: RegistrationRequest = {
    id: randomUUID(),
    status: 'pending',
    contactName: input.contactName,
    workEmail: input.workEmail.trim().toLowerCase(),
    companyName: input.companyName,
    companyWebsite: input.companyWebsite,
    jobTitle: input.jobTitle,
    phone: input.phone,
    companySize: input.companySize,
    useCase: input.useCase,
    passwordHash: input.passwordHash,
    createdAt: now,
    updatedAt: now,
    mailSent: Boolean(input.mailSent),
    mailError: input.mailError,
  }
  const list = readAll()
  list.push(row)
  writeAll(list)
  return row
}

export function updateRegistrationRequest(
  id: string,
  patch: Partial<RegistrationRequest>,
): RegistrationRequest | null {
  const list = readAll()
  const idx = list.findIndex((r) => r.id === id)
  if (idx < 0) return null
  const next = {
    ...list[idx]!,
    ...patch,
    id,
    updatedAt: new Date().toISOString(),
  }
  list[idx] = next
  writeAll(list)
  return next
}

export function publicRegistration(row: RegistrationRequest) {
  const { passwordHash: _pw, ...rest } = row
  return rest
}
