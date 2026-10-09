from .probes import from_probe

TASKS = (
    from_probe(
        "dotnet-sdk8-targets-net9", category="build", error_type="NETSDK1045", runtime={"name": "dotnet", "version": "8.0"}, memory="2g",
        summary="The .NET 8 SDK cannot build a project that targets net9.0 and stops with NETSDK1045, saying the current SDK does not support targeting .NET 9.",
        context="Building a project whose TargetFramework was raised to net9.0 in a CI image or container that still has the .NET 8 SDK.",
        failed_approaches=("dotnet build /tmp/w -p:TargetFramework=net9.0 2>&1", "dotnet build /tmp/w --framework net9.0 2>&1"),
        fix="sed -i 's/net9.0/net8.0/' /tmp/w/w.csproj && dotnet build /tmp/w", verify="dotnet build /tmp/w --no-restore 2>&1 | tail -n 3",
        root_cause="An SDK can build only for target frameworks up to its own version. The SDK that builds net9.0 is .NET 9; the runtime and the targeting packs it needs are not in the 8 SDK.",
        steps=("Install the .NET 9 SDK, or use the mcr.microsoft.com/dotnet/sdk:9.0 image for the build.", "A global.json can pin the SDK version, so every machine fails or succeeds the same way.", "Or lower TargetFramework to net8.0 if you do not need .NET 9."),
        tags=("dotnet", "sdk", "target-framework", "docker"), message="NETSDK1045",
    ),
)

TASKS += (
    from_probe(
        "dotnet-global-json-sdk-missing", category="tooling", error_type="A compatible .NET SDK was not found", runtime={"name": "dotnet", "version": "8.0"}, memory="2g",
        summary="Every dotnet command fails with A compatible .NET SDK was not found when a global.json pins an SDK version that is not installed and forbids rolling forward.",
        context="Running dotnet build in a repository whose global.json names an SDK newer than the one in the CI image.",
        failed_approaches=("cd /w && DOTNET_ROLL_FORWARD=Major dotnet --version 2>&1", "cd /w && dotnet new console -o app 2>&1"),
        fix="""cd /w && printf '{"sdk":{"version":"8.0.100","rollForward":"latestFeature"}}' > global.json""", verify="cd /w && dotnet --version",
        root_cause="global.json selects the SDK for every dotnet command run under its folder. With rollForward set to disable, only the exact version is accepted, and DOTNET_ROLL_FORWARD applies to runtimes, not to SDK selection.",
        steps=("Install the SDK version the file names (or use an image that has it), or", "change global.json: lower the version or allow rolling forward (latestFeature or latestMajor).", "Run dotnet --list-sdks to see what is installed."),
        tags=("dotnet", "global.json", "sdk", "ci"), message="A compatible .NET SDK was not found",
    ),
)

TASKS += (
    from_probe(
        "dotnet-no-restore-assets-missing", category="build", error_type="NETSDK1004", runtime={"name": "dotnet", "version": "8.0"}, memory="2g",
        summary="dotnet build --no-restore stops with NETSDK1004, Assets file project.assets.json not found, when the project was never restored on this machine.",
        context="A CI step or a container build that runs dotnet build --no-restore on a fresh checkout, with no restore step before it.",
        failed_approaches=("dotnet build /tmp/w --no-restore -c Release 2>&1", "dotnet publish /tmp/w --no-restore 2>&1"),
        fix="dotnet restore /tmp/w && dotnet build /tmp/w --no-restore", verify="dotnet build /tmp/w --no-restore 2>&1 | tail -n 3",
        root_cause="--no-restore tells the build to trust obj/project.assets.json, the file that restore writes with the resolved packages. On a fresh checkout it does not exist, so the build has nothing to trust, and neither a different configuration nor clean creates it.",
        steps=("Run dotnet restore before the build, or drop --no-restore so the build restores first.", "In a Dockerfile, copy the project files and restore in their own layer, then copy the sources and build with --no-restore."),
        tags=("dotnet", "nuget", "restore", "docker", "ci"), message="NETSDK1004",
    ),
    from_probe(
        "dotnet-nuget-version-not-found", category="dependency", error_type="NU1102", runtime={"name": "dotnet", "version": "8.0"}, memory="2g",
        summary="dotnet add package fails with NU1102, Unable to find package with version, when the version asked for does not exist on any configured NuGet source.",
        context="Adding a NuGet package with a pinned version that was mistyped, not published yet, or only on a private feed that is not configured here.",
        failed_approaches=("cd /tmp/w && dotnet nuget locals all --clear && dotnet add package Newtonsoft.Json --version 99.0.0 2>&1", "cd /tmp/w && dotnet add package Newtonsoft.Json --version 99.0.0 --source https://api.nuget.org/v3/index.json 2>&1"),
        fix="cd /tmp/w && dotnet add package Newtonsoft.Json --version 13.0.3", verify="grep Newtonsoft /tmp/w/w.csproj",
        root_cause="NU1102 means the package id exists on a source but no version satisfies the request (the message names the nearest ones). Clearing the caches or naming the official source changes nothing when the version itself is not published.",
        steps=("Read the nearest versions in the message and pick a real one, or leave the version out to take the latest.", "If the version lives on a private feed, add that source (nuget.config) and its credentials before restoring."),
        tags=("dotnet", "nuget", "package", "version"), message="NU1102",
    ),
    from_probe(
        "dotnet-msbuild-no-project-file", category="tooling", error_type="MSB1003", runtime={"name": "dotnet", "version": "8.0"}, memory="2g",
        summary="dotnet build fails with MSB1003, Specify a project or solution file, when it runs in a folder that has no .csproj or .sln file.",
        context="Running dotnet build or dotnet restore from the repository root while the project sits in a subfolder.",
        failed_approaches=("cd /w && dotnet build -c Release 2>&1", "cd /w && dotnet restore 2>&1"),
        extra_setup="cd /tmp && dotnet new console -o /w/src >/dev/null",
        fix="cd /w/src && dotnet build", verify="cd /w/src && dotnet build --no-restore 2>&1 | tail -n 3",
        root_cause="The dotnet CLI looks for exactly one project or solution file in the current folder. In a folder with none (or with several), it cannot choose, and flags such as the configuration do not change where it looks.",
        steps=("cd into the folder that holds the .csproj, or pass the path: dotnet build src/App.csproj.", "In a repository with several projects, build the .sln file from the root."),
        tags=("dotnet", "msbuild", "cli", "project"), message="MSB1003",
    ),
)
