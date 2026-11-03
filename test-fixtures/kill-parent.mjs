// A fake "biome" that kills the process that launched it with SIGKILL, to
// simulate the hook being killed mid-run (no chance to clean up).
process.kill(process.ppid, "SIGKILL");
process.exit(0);
