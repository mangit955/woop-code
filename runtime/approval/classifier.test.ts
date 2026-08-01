import { describe, expect, test } from "bun:test";
import { CommandRisk, classifyCommand, splitSegments, tokenize } from "./classifier";
import { DESTINATIONS } from "./destinations";
import { UNRESOLVABLE } from "./paths";

/**
 * A fixed workspace, so a test says the same thing on every machine. Without it
 * the results would depend on where the suite happens to be checked out.
 */
const WORKSPACE = { root: "/workspace", home: "/home/dev" };

/** Reads the table below as a list of `[command, expected risk]` pairs. */
function expectRisk(cases: Array<[string, CommandRisk]>) {
  for (const [command, expected] of cases) {
    expect({ command, risk: classifyCommand(command, WORKSPACE) }).toEqual({
      command,
      risk: expected,
    });
  }
}

describe("read-only commands", () => {
  test("inspecting the filesystem never asks", () => {
    expectRisk([
      ["pwd", CommandRisk.READ_ONLY],
      ["ls -la", CommandRisk.READ_ONLY],
      ["tree src", CommandRisk.READ_ONLY],
      ["find . -name '*.ts'", CommandRisk.READ_ONLY],
      ['rg "TODO" src', CommandRisk.READ_ONLY],
      ['grep -rn "signup" .', CommandRisk.READ_ONLY],
      ["cat package.json", CommandRisk.READ_ONLY],
      ["head -20 README.md", CommandRisk.READ_ONLY],
      ["tail -f log.txt", CommandRisk.READ_ONLY],
      ["stat cli.ts", CommandRisk.READ_ONLY],
      ["file cli.ts", CommandRisk.READ_ONLY],
      ["wc -l cli.ts", CommandRisk.READ_ONLY],
    ]);
  });

  test("inspecting git history never asks", () => {
    expectRisk([
      ["git status", CommandRisk.READ_ONLY],
      ["git diff", CommandRisk.READ_ONLY],
      ["git diff --staged", CommandRisk.READ_ONLY],
      ["git log --oneline -20", CommandRisk.READ_ONLY],
      ["git show HEAD", CommandRisk.READ_ONLY],
      ["git branch", CommandRisk.READ_ONLY],
      ["git branch --list", CommandRisk.READ_ONLY],
      ["git blame cli.ts", CommandRisk.READ_ONLY],
      ["git rev-parse HEAD", CommandRisk.READ_ONLY],
      ["git config --get user.name", CommandRisk.READ_ONLY],
      ["git stash list", CommandRisk.READ_ONLY],
      ["git remote", CommandRisk.READ_ONLY],
    ]);
  });

  test("running the test suite never asks", () => {
    expectRisk([
      ["bun test", CommandRisk.READ_ONLY],
      ["npm test", CommandRisk.READ_ONLY],
      ["pnpm test", CommandRisk.READ_ONLY],
      ["yarn test", CommandRisk.READ_ONLY],
      ["cargo test", CommandRisk.READ_ONLY],
      ["pytest -q", CommandRisk.READ_ONLY],
      ["go test ./...", CommandRisk.READ_ONLY],
    ]);
  });

  test("a redirect to /dev/null is still a read", () => {
    expectRisk([["ls -la > /dev/null", CommandRisk.READ_ONLY]]);
  });
});

describe("workspace writes", () => {
  test("creating and editing inside the tree", () => {
    expectRisk([
      ["mkdir -p src/components", CommandRisk.WORKSPACE_WRITE],
      ["touch src/new.ts", CommandRisk.WORKSPACE_WRITE],
      ["mv src/a.ts src/b.ts", CommandRisk.WORKSPACE_WRITE],
      ["cp src/a.ts src/b.ts", CommandRisk.WORKSPACE_WRITE],
      ["sed -i '' 's/a/b/' cli.ts", CommandRisk.WORKSPACE_WRITE],
    ]);
  });

  test("staging and committing", () => {
    expectRisk([
      ["git add .", CommandRisk.WORKSPACE_WRITE],
      ["git add -A", CommandRisk.WORKSPACE_WRITE],
      ['git commit -m "fix"', CommandRisk.WORKSPACE_WRITE],
      ["git switch main", CommandRisk.WORKSPACE_WRITE],
      ["git checkout main", CommandRisk.WORKSPACE_WRITE],
      ["git stash", CommandRisk.WORKSPACE_WRITE],
      ["git merge main", CommandRisk.WORKSPACE_WRITE],
    ]);
  });

  test("a redirect makes a reading command a write", () => {
    // `cat a` reads, `cat a > b` creates b.
    expectRisk([
      ["cat package.json > copy.json", CommandRisk.WORKSPACE_WRITE],
      ["echo hi >> notes.md", CommandRisk.WORKSPACE_WRITE],
      ["ls > files.txt", CommandRisk.WORKSPACE_WRITE],
    ]);
  });

  test("building writes to the tree", () => {
    expectRisk([
      ["cargo build", CommandRisk.WORKSPACE_WRITE],
      ["go build ./...", CommandRisk.WORKSPACE_WRITE],
      ["cargo fmt", CommandRisk.WORKSPACE_WRITE],
    ]);
  });
});

describe("destructive commands", () => {
  test("deleting always asks", () => {
    expectRisk([
      ["rm -rf node_modules", CommandRisk.DESTRUCTIVE],
      ["rm file.txt", CommandRisk.DESTRUCTIVE],
      ["rmdir build", CommandRisk.DESTRUCTIVE],
      ["find . -name '*.log' -delete", CommandRisk.DESTRUCTIVE],
      ["truncate -s 0 log.txt", CommandRisk.DESTRUCTIVE],
    ]);
  });

  test("discarding or rewriting git state always asks", () => {
    expectRisk([
      ["git reset --hard", CommandRisk.DESTRUCTIVE],
      ["git reset --hard HEAD~3", CommandRisk.DESTRUCTIVE],
      ["git clean -fd", CommandRisk.DESTRUCTIVE],
      ["git checkout -- src/cli.ts", CommandRisk.DESTRUCTIVE],
      ["git restore src/cli.ts", CommandRisk.DESTRUCTIVE],
      ["git branch -D feature", CommandRisk.DESTRUCTIVE],
      ["git rebase -i HEAD~3", CommandRisk.DESTRUCTIVE],
      ["git stash drop", CommandRisk.DESTRUCTIVE],
    ]);
  });

  test("running code the classifier cannot see always asks", () => {
    // `npm run` and `bun <file>` execute whatever the script does.
    expectRisk([
      ["npm run build", CommandRisk.DESTRUCTIVE],
      ["bun run scripts/migrate.ts", CommandRisk.DESTRUCTIVE],
      ["find . -exec rm {} ;", CommandRisk.DESTRUCTIVE],
    ]);
  });

  test("an unrecognised command asks rather than running", () => {
    // The safe default: a command nobody has classified is not assumed safe.
    expectRisk([
      ["some-unknown-binary --flag", CommandRisk.DESTRUCTIVE],
      ["./scripts/deploy.sh", CommandRisk.DESTRUCTIVE],
      ["python migrate.py", CommandRisk.DESTRUCTIVE],
      ["", CommandRisk.DESTRUCTIVE],
      ["   ", CommandRisk.DESTRUCTIVE],
    ]);
  });
});

describe("system commands", () => {
  test("privilege escalation always asks", () => {
    expectRisk([
      ["sudo rm -rf /", CommandRisk.SYSTEM],
      ["sudo apt-get install curl", CommandRisk.SYSTEM],
      ["su - root", CommandRisk.SYSTEM],
      ["doas pkg install", CommandRisk.SYSTEM],
    ]);
  });

  test("permissions and machine state always ask", () => {
    expectRisk([
      ["chmod +x script.sh", CommandRisk.SYSTEM],
      ["chown user:group file", CommandRisk.SYSTEM],
      ["systemctl restart nginx", CommandRisk.SYSTEM],
      ["brew install ripgrep", CommandRisk.SYSTEM],
      ["reboot", CommandRisk.SYSTEM],
    ]);
  });

  test("network access always asks", () => {
    expectRisk([
      ["curl https://example.com", CommandRisk.SYSTEM],
      ["wget https://example.com/x.tar.gz", CommandRisk.SYSTEM],
      ["git push", CommandRisk.SYSTEM],
      ["git push --force origin main", CommandRisk.SYSTEM],
      ["git pull", CommandRisk.SYSTEM],
      ["git fetch --all", CommandRisk.SYSTEM],
      ["npm install", CommandRisk.SYSTEM],
      ["bun add react", CommandRisk.SYSTEM],
      ["pip install requests", CommandRisk.SYSTEM],
    ]);
  });

  test("leaving the workspace always asks", () => {
    expectRisk([
      ["mv src/a.ts /etc/a.ts", CommandRisk.SYSTEM],
      ["cp secrets.env ~/backup.env", CommandRisk.SYSTEM],
      ["mv src/a.ts ../../elsewhere/a.ts", CommandRisk.SYSTEM],
      ["echo hi > /etc/hosts", CommandRisk.SYSTEM],
    ]);
  });
});

describe("a command line is only as safe as its riskiest part", () => {
  test("a chain takes the highest risk of its segments", () => {
    expectRisk([
      ["git status && rm -rf node_modules", CommandRisk.DESTRUCTIVE],
      ["ls; sudo reboot", CommandRisk.SYSTEM],
      ["cat a.txt || rm a.txt", CommandRisk.DESTRUCTIVE],
      ["mkdir build && cd build", CommandRisk.DESTRUCTIVE], // cd is unrecognised
      ["git status && git diff", CommandRisk.READ_ONLY],
    ]);
  });

  test("a pipeline classifies every stage", () => {
    expectRisk([
      ["cat package.json | jq .name", CommandRisk.READ_ONLY],
      ["ls | xargs rm", CommandRisk.DESTRUCTIVE],
      ['grep -rl "TODO" . | xargs sed -i "" s/a/b/', CommandRisk.DESTRUCTIVE],
    ]);
  });

  test("command substitution is classified too", () => {
    // The inner command runs, so hiding it inside $() must not hide its risk.
    expectRisk([
      ["echo $(rm -rf build)", CommandRisk.DESTRUCTIVE],
      ["echo `sudo whoami`", CommandRisk.SYSTEM],
      ["echo $(git status)", CommandRisk.READ_ONLY],
    ]);
  });

  test("quoted operators are not operators", () => {
    // The pattern contains "&&" but there is only one command here.
    expectRisk([
      ['rg "a && b" src', CommandRisk.READ_ONLY],
      ['grep "; rm -rf /" log.txt', CommandRisk.READ_ONLY],
      ['echo "sudo"', CommandRisk.READ_ONLY],
    ]);
  });

  test("wrappers and env assignments do not hide the command", () => {
    expectRisk([
      ["time ls", CommandRisk.READ_ONLY],
      ["FOO=bar ls", CommandRisk.READ_ONLY],
      ["env FOO=bar rm -rf x", CommandRisk.DESTRUCTIVE],
      ["nohup rm -rf x", CommandRisk.DESTRUCTIVE],
      ["/usr/bin/git status", CommandRisk.READ_ONLY],
    ]);
  });

  test("a comment cannot smuggle a command", () => {
    expectRisk([["ls # rm -rf /", CommandRisk.READ_ONLY]]);
  });
});

describe("segment splitting", () => {
  test("splits on shell operators", () => {
    expect(splitSegments("a && b || c ; d | e")).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("keeps quoted operators intact", () => {
    expect(splitSegments('rg "a && b" src')).toEqual(['rg "a && b" src']);
    expect(splitSegments("echo 'a; b'")).toEqual(["echo 'a; b'"]);
  });

  test("lifts substitutions out as their own segments", () => {
    // The outer command keeps a placeholder where the output will land, so an
    // argument it cannot read still counts as an argument.
    expect(splitSegments("echo $(git status)")).toEqual(["git status", `echo ${UNRESOLVABLE}`]);
    expect(splitSegments("echo `ls`")).toEqual(["ls", `echo ${UNRESOLVABLE}`]);
  });

  test("handles an unterminated substitution without hanging", () => {
    expect(() => splitSegments("echo $(ls")).not.toThrow();
    expect(() => splitSegments("echo `ls")).not.toThrow();
    expect(() => splitSegments('echo "unclosed')).not.toThrow();
  });
});

describe("tokenizing", () => {
  test("keeps quoted arguments together", () => {
    expect(tokenize('rg "two words" src')).toEqual(["rg", "two words", "src"]);
    expect(tokenize("git commit -m 'a message'")).toEqual([
      "git",
      "commit",
      "-m",
      "a message",
    ]);
  });

  test("keeps an empty quoted argument", () => {
    // `sed -i ''` on macOS: dropping the empty argument would change the command.
    expect(tokenize("sed -i '' s/a/b/ f")).toEqual(["sed", "-i", "", "s/a/b/", "f"]);
  });

  test("respects escapes", () => {
    expect(tokenize("cat my\\ file.txt")).toEqual(["cat", "my file.txt"]);
  });
});

/**
 * One pair per write-capable command: the same command aimed inside the
 * workspace and aimed outside it. Both directions are asserted, so a rule that
 * is too loose and a rule that is too tight both fail here.
 */
const BOUNDARY_CASES: Record<string, { inside: string; outside: string }> = {
  mkdir: { inside: "mkdir -p src/components", outside: "mkdir -p /etc/woop" },
  touch: { inside: "touch src/new.ts", outside: "touch ~/.zshrc" },
  tee: { inside: "tee notes.md", outside: "tee /etc/hosts" },
  ln: { inside: "ln -s src/a src/b", outside: "ln -sf payload ~/bin/ls" },
  cp: { inside: "cp src/a.ts src/b.ts", outside: "cp --target-directory=/etc secrets.env" },
  mv: { inside: "mv src/a.ts src/b.ts", outside: "mv src/a.ts /etc/a.ts" },
  patch: { inside: "patch -p1 changes.diff", outside: "patch -d /etc -p1 changes.diff" },
  sed: { inside: "sed -i '' 's/a/b/' cli.ts", outside: "sed -i '' 's/a/b/' /etc/hosts" },
  awk: { inside: `awk '{print > "out.txt"}' f`, outside: `awk '{print > "/etc/passwd"}' f` },
  gawk: { inside: `gawk '{print > "out.txt"}' f`, outside: `gawk '{print > "/etc/passwd"}' f` },
  git: { inside: "git add .", outside: "git -C /etc add ." },
  cargo: { inside: "cargo build", outside: "cargo build --target-dir /tmp/out" },
  go: { inside: "go build ./...", outside: "go build -o /usr/local/bin/woop" },
};

describe("workspace boundary", () => {
  test("every write-capable command is covered in both directions", () => {
    // A command declared in DESTINATIONS with no case here would otherwise
    // change behaviour unobserved.
    expect(Object.keys(BOUNDARY_CASES).sort()).toEqual(Object.keys(DESTINATIONS).sort());
  });

  for (const [name, { inside, outside }] of Object.entries(BOUNDARY_CASES)) {
    test(`${name} writes inside the workspace without asking`, () => {
      expectRisk([[inside, CommandRisk.WORKSPACE_WRITE]]);
    });

    test(`${name} asks before writing outside the workspace`, () => {
      expectRisk([[outside, CommandRisk.SYSTEM]]);
    });
  }

  test("a destination hidden in an attached flag value is still a destination", () => {
    expectRisk([
      ["cp -t /etc secrets.env", CommandRisk.SYSTEM],
      ["cp --target-directory=/etc secrets.env", CommandRisk.SYSTEM],
      ["go build -o/usr/local/bin/woop", CommandRisk.SYSTEM],
      ["cargo build --target-dir=/tmp/out", CommandRisk.SYSTEM],
    ]);
  });

  test("a destination that cannot be resolved is treated as outside", () => {
    expectRisk([
      ["cp src/a.ts $HOME/a.ts", CommandRisk.SYSTEM],
      ["touch ${TARGET}", CommandRisk.SYSTEM],
      ["mkdir -p $(dirname /etc/woop/x)", CommandRisk.SYSTEM],
      [`awk '{print > out}' f`, CommandRisk.SYSTEM],
    ]);
  });

  test("climbing out of the workspace asks, however it is spelled", () => {
    expectRisk([
      ["mkdir ../../evil", CommandRisk.SYSTEM],
      ["touch src/../../escaped.txt", CommandRisk.SYSTEM],
      ["mv src/a.ts ../../elsewhere/a.ts", CommandRisk.SYSTEM],
      ["echo hi > /etc/hosts", CommandRisk.SYSTEM],
    ]);
  });

  test("an absolute path inside the workspace is an ordinary write", () => {
    // The whole reason the classifier is given a root: this used to be
    // indistinguishable from writing to /etc.
    expectRisk([
      ["touch /workspace/src/new.ts", CommandRisk.WORKSPACE_WRITE],
      ["sed -i '' 's/a/b/' /workspace/cli.ts", CommandRisk.WORKSPACE_WRITE],
      ["cat pkg.json > /workspace/copy.json", CommandRisk.WORKSPACE_WRITE],
    ]);
  });

  test("a global flag's value is not mistaken for a git subcommand", () => {
    expectRisk([
      ["git -C src status", CommandRisk.READ_ONLY],
      ["git -C src add .", CommandRisk.WORKSPACE_WRITE],
      ["git --git-dir=/etc/x add .", CommandRisk.SYSTEM],
    ]);
  });
});
