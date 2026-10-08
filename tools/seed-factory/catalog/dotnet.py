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
