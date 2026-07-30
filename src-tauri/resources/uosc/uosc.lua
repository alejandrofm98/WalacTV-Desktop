-- uosc loader: mpv's --scripts option doesn't add the script dir to package.path,
-- so uosc's require('lib/...') and require('elements/...') fail. Set package.path
-- to this script's own directory, then load the real main.lua in the same lua state.
local src = debug.getinfo(1, 'S').source or ''
local dir = src:gsub('^@', '')
dir = dir:gsub('\\', '/')
dir = dir:match('(.*/)') or './'
package.path = dir .. '?.lua;'
    .. dir .. '?/init.lua;'
    .. dir .. 'lib/?.lua;'
    .. dir .. 'lib/?/init.lua;'
    .. dir .. 'elements/?.lua;'
    .. dir .. 'elements/?/init.lua;'
    .. package.path
-- walactv: expose dir so intl.lua can use it when mp.get_script_directory() returns nil
_G.UOSC_DIR = dir

-- walactv: override mp.get_script_directory() to fall back to the uosc dir when
-- the original returns nil. The loader bypasses mpv's normal script context.
local _uosc_dir = dir
local _orig_script_dir = mp.get_script_directory
mp.get_script_directory = function(...)
	local ok, r = pcall(_orig_script_dir, ...)
	if ok and r and r ~= '' then return r end
	return _uosc_dir
end
mp.msg.info('uosc-loader: dir=' .. dir .. ' package.path extended (UOSC_DIR=' .. (_G.UOSC_DIR or 'nil') .. '), loading main.lua')
dofile(dir .. 'main.lua')
-- Keep mpv's built-in OSC as a fallback unless uosc loaded successfully.
mp.set_property('osc', 'no')
