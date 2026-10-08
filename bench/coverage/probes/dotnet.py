from probe import P

PROBES = [
    P("dotnet-sdk8-targets-net9", "dotnet", "mcr.microsoft.com/dotnet/sdk:8.0", "cd /tmp && dotnet new console -o w --framework net8.0 >/dev/null && sed -i 's/net8.0/net9.0/' w/w.csproj",
      "dotnet build w 2>&1", r"(error NETSDK1045:.*)",
      {"dotnet_sdk": "8.0", "target": "net9.0"}, "https://raw.githubusercontent.com/dotnet/sdk/main/src/Tasks/Common/Resources/Strings.resx",
      "NETSDK1045", "MIT", must=(r"NETSDK1045|does not support targeting", r"\.NET 9|net9\.0")),
    P("dotnet-global-json-sdk-missing", "dotnet", "mcr.microsoft.com/dotnet/sdk:8.0",
      r'''mkdir /w && cd /w && printf '{"sdk":{"version":"9.0.100","rollForward":"disable"}}' > global.json''',
      "cd /w && dotnet --version 2>&1", r"A compatible .NET SDK was not found",
      {"dotnet_sdk": "8.0", "global.json": "9.0.100"}, "https://raw.githubusercontent.com/dotnet/sdk/main/src/Tasks/Common/Resources/Strings.resx",
      "global.json", "MIT", must=(r"global\.json", r"SDK")),
    P("dotnet-runtime-version-missing", "dotnet", "mcr.microsoft.com/dotnet/sdk:8.0",
      r'''cd /tmp && dotnet new console -o w --framework net8.0 >/dev/null && dotnet build w -o /tmp/out >/dev/null && sed -i 's/"version": "8.0.[0-9]*"/"version": "9.0.0"/' /tmp/out/w.runtimeconfig.json''',
      "dotnet /tmp/out/w.dll 2>&1", r"You must install or update \.NET to run this application",
      {"dotnet_runtime": "8.0", "required": "9.0.0"}, "https://raw.githubusercontent.com/dotnet/runtime/main/src/native/corehost/error_codes.h",
      "FrameworkMissingFailure", "MIT", must=(r"Framework", r"install|update|roll-?forward|DOTNET_ROLL_FORWARD")),
]
