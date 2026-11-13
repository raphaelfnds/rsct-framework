import { fileURLToPath } from 'node:url'

process.env.RSCT_UPDATE_CHECK = 'off'

export const TEST_GIT_CONFIG_FIXTURE = fileURLToPath(
  new URL(process.platform === 'win32' ? './fixtures/gitconfig-win32' : './fixtures/gitconfig', import.meta.url),
)
export const TEST_XDG_CONFIG_HOME = fileURLToPath(new URL('./fixtures/xdg-config-home-absent', import.meta.url))

process.env.GIT_CONFIG_GLOBAL = TEST_GIT_CONFIG_FIXTURE
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.XDG_CONFIG_HOME = TEST_XDG_CONFIG_HOME
