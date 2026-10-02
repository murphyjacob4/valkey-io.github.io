+++
title = "Commands"
template = "commands.html"
page_template = "command-page.html"
aliases= [
    "/docs/topics/commands/"
]

[extra]
# Number of commands shown initially and added on each "Show more" click.
commands_page_size = 10

# Most-used commands, in order of relevance. These are sorted to the top of the command
# reference (and of each category tab), ahead of the remaining commands in alphabetical order.
# Values are command page slugs (the file name in valkey-doc/commands without `.md`).
popular_commands = [
    # Shown on first load (first `commands_page_size` entries)
    "get",
    "set",
    "del",
    "expire",
    "incr",
    "hset",
    "hget",
    "lpush",
    "zadd",
    "scan",
    # Revealed by "Show more"
    "mget",
    "mset",
    "exists",
    "ttl",
    "hgetall",
    "hdel",
    "rpush",
    "lpop",
    "lrange",
    "sadd",
    "smembers",
    "sismember",
    "srem",
    "zrange",
    "zscore",
    "zrem",
    "zincrby",
    "incrby",
    "decr",
    "getdel",
    "hincrby",
    "hmget",
    "rpop",
    "blpop",
    "publish",
    "subscribe",
    "multi",
    "exec",
    "watch",
    "eval",
    "fcall",
    "xadd",
    "xread",
    "xreadgroup",
    "xack",
    "persist",
    "pexpire",
    "type",
    "unlink",
    "ping",
    "auth",
    "hello",
    "info",
    "config-get",
    "config-set",
    "client-list",
    "json.set",
    "json.get",
    "ft.search",
    "bf.add",
]
+++
