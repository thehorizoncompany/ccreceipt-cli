import { test } from "node:test";
import assert from "node:assert/strict";
import { projectName, tildePath } from "../src/project.js";
import { projectLabeler } from "../src/redact.js";

test("project name is the last folder of the working directory", () => {
  assert.equal(projectName("/home/demo/acme-api"), "acme-api");
  assert.equal(projectName("/home/demo/acme-api/"), "acme-api");
  assert.equal(projectName("/Users/me/Documents/project/ride project/Ride"), "Ride");
});

test("a Claude Code worktree belongs to the repository it was created in", () => {
  assert.equal(projectName("/home/demo/acme-api/.claude/worktrees/brave-turing-1a2b3c"), "acme-api");
  assert.equal(projectName("/Users/me/ride project/Ride/.claude/worktrees/cool-chatelet-f4aec9"), "Ride");
  assert.equal(projectName("/home/demo/acme-api/.claude/worktrees/brave-turing-1a2b3c/packages/web"), "acme-api");
});

test("Windows paths give the same names", () => {
  assert.equal(projectName("C:\\Users\\demo\\acme-api"), "acme-api");
  assert.equal(projectName("C:\\Users\\demo\\acme-api\\.claude\\worktrees\\brave-turing-1a2b3c"), "acme-api");
});

test("a .claude folder that is not a worktree is left alone", () => {
  assert.equal(projectName("/home/demo/.claude"), ".claude");
  assert.equal(projectName("/home/demo/acme-api/.claude/commands"), "commands");
});

test("missing working directory", () => {
  assert.equal(projectName(null), "?");
  assert.equal(projectName(""), "?");
});

test("tildePath writes the home folder as ~, and nothing else", () => {
  assert.equal(tildePath("/Users/ana/.claude/projects", "/Users/ana"), "~/.claude/projects");
  assert.equal(tildePath("/Users/ana", "/Users/ana"), "~");
  assert.equal(tildePath("/Users/anabel/.claude", "/Users/ana"), "/Users/anabel/.claude", "a longer name is not the home folder");
  assert.equal(tildePath("/srv/sessions", "/Users/ana"), "/srv/sessions");
  assert.equal(tildePath("C:\\Users\\ana\\.claude\\projects", "C:\\Users\\ana", "\\"), "~\\.claude\\projects");
});

test("--redact labels: a worktree gets the same project-N as its repository", () => {
  const label = projectLabeler();
  assert.equal(label(projectName("/home/demo/acme-api")), "project-1");
  assert.equal(label(projectName("/home/demo/acme-api/.claude/worktrees/brave-turing-1a2b3c")), "project-1");
  assert.equal(label(projectName("/home/demo/other")), "project-2");
});
