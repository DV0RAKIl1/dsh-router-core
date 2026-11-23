/**
 * 供应商 loader —— 扫描 **用户目录**下的 *.js，动态 import，按契约包装成
 * 内部 Supplier，并暴露"能力检测"(capabilities)供通用路由/前端按能力渲染。
 *
 * 加载来源（两处）：
 *   1. 用户：`~/.dsh/profiles/<profile>/suppliers/*.js`（自定义供应商）
 *   2. 内置：**插件页「包含的组件」里的行** —— core 自己的 cordis.patch.yml
 *      insert 了三个子路径模块，经 `router.suppliers` 表进来，与独立安装的
 *      供应商插件同一条通道，核心不区分内外，只看工厂上的 `source` 标签。
 *
 * 内置曾经也是「扫 `<plugin>/lib/suppliers/*.js`」（本文件早先的 builtinDir）。
 * 改成行之后那条路径已删：扫目录拿不到行的身份（插件页的开关/显示名/说明），
 * 而且关一个内置供应商要手改配置才生效 —— 行才有宿主管的开关。
 */
import { readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ServerResponse } from 'node:http'
import type { ChatRequest, ModelInfo, ModelWithEnabled, ResponsesRequest, Supplier, SupplierStatus } from '../router/types.ts'
import type { SupplierConfigStore } from '../supplier-config.ts'
import type { CredentialStore } from '../credential-store.ts'
import type { ChatOnceResult, ResponsesOnceResult, SupplierAccountNow, SupplierBundle, SupplierEnv, SupplierFactory, SupplierModule } from './contract.ts'
import { AccountPool } from '../router/account-pool.ts'

/** 供应商加载错误（不阻断其他供应商）。 */
export interface SupplierLoadError {
  id: string
  file: string
  error: string
}

/** 供应商实例 + 能力标记。 */
export interface LoadedSupplier {
  supplier: Supplier
  /** 差异化能力集合（方法名存在性，通用能力不在此列）。 */
  capabilities: Set<string>
  /** 来源：内置 / 用户目录 / 外部插件（cordis service）。 */
  source: 'builtin' | 'user' | 'external'
}

function isFn(v: unknown): v is (...args: unknown[]) => unknown {
  return typeof v === 'function'
}

/**
 * 积分回灌（核心统一持久化，插件不落盘）。
 *
 * 插件的积分是异步拉的：重启后第一次 status() 拿不到真值，报 `CREDITS_UNKNOWN`
 * (-1)。这里做两件事：
 *   - 报了真值 → 写入 supplier-config.json（下次重启还在）
 *   - 报了 -1 → 用上次存的顶上，面板不会闪 0
 *
 * 插件不该自己把 0 当「未知」报上来 —— 0 是真值（用完了），核心分不清，
 * 会把缓存冲成 0。这条是本层存在的理由（2026-09-03）。
 */
function hydrateCredits(supplierId: string, store: SupplierConfigStore, accounts: SupplierAccountNow[]): SupplierAccountNow[] {
  return accounts.map((a) => {
    const merged = store.putCredits(supplierId, a.uid, a.credits)
    return merged === a.credits ? a : { ...a, credits: merged }
  })
}

type ResolvedSupplierFile = SupplierModule | SupplierFactory | SupplierBundle

function isSupplierBundle(value: unknown): value is SupplierBundle {
  if (typeof value !== 'object' || value === null) return false
  const bundle = value as Partial<SupplierBundle>
  return bundle.kind === 'dsh-supplier-bundle' && Array.isArray(bundle.providers)
}

/** 从模块导出解析出供应商模块、工厂或显式标记的多供应商 bundle。 */
function resolveModule(mod: Record<string, unknown>, file: string): ResolvedSupplierFile {
  const cand = mod.default ?? mod
  if (isSupplierBundle(cand)) {
    if (cand.providers.length === 0) throw new Error(`供应商 bundle 为空: ${file}`)
    const ids = new Set<string>()
    for (const provider of cand.providers) {
      if (!provider || typeof provider.id !== 'string' || provider.id === '' || typeof provider.create !== 'function') {
        throw new Error(`供应商 bundle 条目无效: ${file}`)
      }
      if (ids.has(provider.id)) throw new Error(`供应商 bundle id 重复: ${provider.id}`)
      ids.add(provider.id)
    }
    return cand
  }
  // factory 形式：模块 default 是 (env) => SupplierModule，实例在 loadOne 阶段创建。
  if (typeof cand === 'function') return cand as SupplierFactory
  if (typeof cand !== 'object' || cand === null) throw new Error(`供应商模块无效: ${file}`)
  if (typeof (cand as Record<string, unknown>).id !== 'string' || (cand as Record<string, unknown>).id === '') {
    throw new Error(`供应商缺少 id: ${file}`)
  }
  if (typeof (cand as Record<string, unknown>).name !== 'string' || (cand as Record<string, unknown>).name === '') {
    throw new Error(`供应商缺少 name: ${file}`)
  }
  return cand as SupplierModule
}

/** 加载单个供应商文件，返回模块对象或显式标记的 bundle。 */
async function importSupplierFile(file: string): Promise<ResolvedSupplierFile> {
  const url = pathToFileURL(file).href
  const mod = (await import(url)) as Record<string, unknown>
  return resolveModule(mod, file)
}

/**
 * 差异化能力（供应商 js 实现；其余为通用能力由核心提供）。
 * testModel / 连接池 / 模型管理 / 别名 / 凭证存储均为核心通用能力，不在此列。
 */
const DIFF_CAPS = [
  'generateLoginUrl', 'completeLogin',
  'addApiKey',
  'pollLogin',
  'checkinNow',
] as const

/**
 * 每个供应商一份 env 副本：`onLateFailure` 是**按供应商**绑到本供应商的池上
 * 的（见 wrapModule），共用一个 env 对象会让所有插件的上报都落到最后一个
 * 供应商的池里。副本是浅拷贝，store/credentials 仍是同一实例。
 */
function ownEnv(env: SupplierEnv): SupplierEnv {
  return { ...env }
}

function createSupplier(factory: SupplierFactory, env: SupplierEnv, file: string, expectedId?: string): SupplierModule {
  const instance = factory(env)
  if (typeof instance !== 'object' || instance === null || typeof instance.id !== 'string' || instance.id === '') {
    throw new Error(`供应商 factory 返回无效${expectedId ? `: ${expectedId}` : ''} in ${file}`)
  }
  if (expectedId && instance.id !== expectedId) {
    throw new Error(`供应商 bundle id 不匹配: expected ${expectedId}, got ${instance.id} in ${file}`)
  }
  return instance
}

/** 从文件构造一个或多个 LoadedSupplier；bundle 成员各自拥有 env 和池。 */
async function loadFile(file: string, env: SupplierEnv, source: 'builtin' | 'user'): Promise<{
  loaded: LoadedSupplier[]
  errors: SupplierLoadError[]
}> {
  const resolved = await importSupplierFile(file)
  if (!isSupplierBundle(resolved)) {
    const mine = ownEnv(env)
    const instance = typeof resolved === 'function' ? createSupplier(resolved, mine, file) : resolved
    return { loaded: [wrapModule(instance, mine, file, source)], errors: [] }
  }

  const loaded: LoadedSupplier[] = []
  const errors: SupplierLoadError[] = []
  for (const provider of resolved.providers) {
    const mine = ownEnv(env)
    try {
      const instance = createSupplier(provider.create, mine, file, provider.id)
      loaded.push(wrapModule(instance, mine, file, source))
    } catch (error) {
      errors.push({ id: provider.id, file, error: (error as Error).message })
    }
  }
  return { loaded, errors }
}

/**
 * 从 SupplierModule 实例构造 LoadedSupplier（能力检测 + Supplier 包装）。
 * 文件加载（loadOne）与外部插件供应商（cordis service）共用。
 */
export function wrapModule(instance: SupplierModule, env: SupplierEnv, source: string, kind: 'builtin' | 'user' | 'external' = 'external'): LoadedSupplier {
  if (typeof instance !== 'object' || instance === null || typeof instance.id !== 'string' || instance.id === '') {
    throw new Error(`供应商模块无效: ${source}`)
  }
  // 测试模型由核心统一走 chatOnce 路径（账号池回退/冷却自动生效），插件无需实现 testModel
  const capabilities = new Set<string>()
  for (const key of DIFF_CAPS) {
    if (isFn((instance as unknown as Record<string, unknown>)[key])) capabilities.add(key)
  }

  // 账号池由核心持有（选号/冷却/错误累计），插件不参与。
  // 挂在 supplier 上：status() 叠加状态与 Router 的 chat 循环共用同一实例。
  // 冷却键带 supplierId（跨供应商同名模型不串），故构造时注入本供应商 id。
  const pool = new AccountPool(instance.id)

  // 迟到失败的上报通道：流式响应已提交后插件才发现的错误，经它落回同一个池。
  // **直接挂在插件持有的那个 env 对象上**（不新建副本）——factory 在建 pool
  // 之前就跑完了，插件若构造时读了 env 就永远拿不到这个字段。插件必须在
  // **调用时**读 `env.onLateFailure`（见契约注释），此刻它已经挂好。
  env.onLateFailure = (uid, model, state, message): void => {
    if (uid === '') return // 无账号供应商（如 opencode）没号可记
    pool.noteFailure(uid, model, state, message)
  }

  const supplier: Supplier = {
    id: instance.id,
    name: instance.name,
    priority: instance.priority ?? 0,
    wire: instance.wire,
    icon: instance.icon,
    apiKeyHint: (instance as { apiKeyHint?: string }).apiKeyHint,
    status: (): SupplierStatus => {
      const now = instance.status()
      // 连接池显示别名覆盖：uid 不变，只改面板展示名
      const accounts = now.accounts.map((a) => {
        const alias = env.store.getAccountName(instance.id, a.uid)
        return alias === undefined || alias === a.nickname ? a : { ...a, nickname: alias }
      })
      return { id: now.id, name: now.name, accounts: pool.decorate(hydrateCredits(instance.id, env.store, accounts)) }
    },
    listModels: (force?: boolean): Promise<ModelInfo[]> | ModelInfo[] => instance.listModels(force),
    // 通用能力：模型启用状态/自定义由核心 SupplierConfigStore 合并
    modelsWithEnabled: (force?: boolean): Promise<ModelWithEnabled[]> | ModelWithEnabled[] => {
      const cfg = env.store.get(instance.id)
      const disabled = new Set(cfg.disabled)
      const custom = new Set(cfg.custom)
      return Promise.resolve(instance.listModels(force)).then((list) =>
        list.map((mm) => ({
          ...mm,
          enabled: !disabled.has(mm.id),
          custom: custom.has(mm.id) ? true : undefined,
        })),
      )
    },
    // 别名留空即用供应商 id（默认值）——别名是用户可改的展示前缀，唯一性由核心校验
    getAlias: (): string => env.store.get(instance.id).alias || instance.id,
    customModelIds: (): string[] => [...env.store.get(instance.id).custom],
    accounts: (): SupplierAccountNow[] => instance.status().accounts,
    chatOnce: (uid: string, lv: string, req: ChatRequest): Promise<ChatOnceResult> => instance.chatOnce(uid, lv, req),
    ...(isFn(instance.responsesOnce) ? {
      responsesOnce: (uid: string, lv: string, req: ResponsesRequest): Promise<ResponsesOnceResult> => instance.responsesOnce!(uid, lv, req),
    } : {}),
    // 删除链接：数据删除是通用能力，凭证清理由供应商内部实现（js 契约不要求）
    removeLink: isFn((instance as unknown as Record<string, unknown>).removeLink)
      ? (uid: string): Promise<boolean> => (instance as unknown as { removeLink(uid: string): Promise<boolean> }).removeLink(uid)
      : undefined,
    dispose: (): void => instance.dispose(),
    pool,
  }
  // 差异化路由通过 LoadedSupplier.capabilities + supplier 实例调用面板方法
  ;(supplier as Supplier & { __module?: SupplierModule }).__module = instance

  return { supplier, capabilities, source: kind }
}

/** 扫描目录下所有 *.js（一层）。 */
function scanDir(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

/**
 * 同 id 冲突时的优先级：**用户目录 js > 内置行 > 外部插件供应商**。
 *
 * 为什么用户目录最高：用户放一个同 id 的 js 就是想替换它，这是「扫目录时代」
 * 就有的语义（见本文件早先的 `loadSuppliers`：内置被用户版覆盖），内置改成行
 * 之后不能悄悄反过来。
 *
 * 纯函数 + 有测试：这条规则错了不会抛异常，只会让用户的覆盖悄悄失效。
 */
const SUPPLIER_RANK: Record<LoadedSupplier['source'], number> = { user: 2, builtin: 1, external: 0 }

export function supplierWins(incoming: LoadedSupplier['source'], existing: LoadedSupplier['source']): boolean {
  return SUPPLIER_RANK[incoming] > SUPPLIER_RANK[existing]
}

export interface LoadSuppliersOptions {
  /** 用户供应商目录（~/.dsh/profiles/<profile>/suppliers）。 */
  userDir: string
  /** 数据目录。 */
  dataDir: string
  /** 通用配置存储。 */
  store: SupplierConfigStore
  /** 通用凭证存储。 */
  credentials: CredentialStore
  log: (msg: string) => void
}

/**
 * 加载用户目录下的供应商。同一个 id 出现多个文件时**后者覆盖前者**（按文件名序），
 * 与内置共存的裁决交给核心（`registerLoaded` 的优先级：用户目录 js > 行）。
 */
export async function loadSuppliers(opts: LoadSuppliersOptions): Promise<{
  suppliers: LoadedSupplier[]
  errors: SupplierLoadError[]
}> {
  const env: SupplierEnv = { dataDir: opts.dataDir, log: opts.log, store: opts.store, credentials: opts.credentials }
  const byId = new Map<string, LoadedSupplier>()
  const errors: SupplierLoadError[] = []

  for (const f of scanDir(opts.userDir).sort()) {
    try {
      const result = await loadFile(f, env, 'user')
      for (const error of result.errors) {
        errors.push(error)
        opts.log(`supplier load failed ${error.id} from ${basename(f)}: ${error.error}`)
      }
      for (const loaded of result.loaded) {
        byId.set(loaded.supplier.id, loaded)
        opts.log(`supplier ${loaded.supplier.id} loaded (user) from ${basename(f)}`)
      }
    } catch (err) {
      errors.push({ id: basename(f, '.js'), file: f, error: (err as Error).message })
      opts.log(`supplier load failed ${basename(f)}: ${(err as Error).message}`)
    }
  }
  return { suppliers: [...byId.values()], errors }
}
