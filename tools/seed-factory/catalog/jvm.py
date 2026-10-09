from .probes import from_probe

J17 = {"name": "java", "version": "17"}
J21 = {"name": "java", "version": "21"}
J23 = {"name": "java", "version": "23"}

TASKS = (
    from_probe(
        "jvm-lombok-jdk23", category="build", error_type="cannot find symbol", runtime=J23,
        summary="JDK 23 stopped running annotation processors found on the class path unless asked, so Lombok no longer generates getters and javac reports cannot find symbol for them.",
        context="Compiling a class that uses Lombok annotations after moving the build from JDK 21 to JDK 23.",
        extra_setup="cd /w",
        failed_approaches=("cd /w && javac -proc:none -cp /tmp/lombok.jar A.java 2>&1", "cd /w && javac -source 21 -cp /tmp/lombok.jar A.java 2>&1"),
        fix="cd /w && javac -proc:full -cp /tmp/lombok.jar A.java", verify="cd /w && java -cp . A",
        root_cause="From JDK 23 javac only runs annotation processors when it is told to (-proc:full, or a processor path or name). Until then it still compiled with a warning. Lombok is an annotation processor, so without it the generated members do not exist.",
        steps=("Add -proc:full to the javac options, or list Lombok on the annotation processor path.", "In Maven set <proc>full</proc> on maven-compiler-plugin; in Gradle declare Lombok with compileOnly and annotationProcessor.", "Use a Lombok release that supports the JDK you build with."),
        tags=("java", "lombok", "jdk23", "annotation-processing"), message="error: cannot find symbol", memory="1g",
    ),
    from_probe(
        "jvm-java17-inaccessible-object", category="runtime", error_type="InaccessibleObjectException", runtime=J17, memory="1g",
        summary="Since Java 17 the JDK's internals are encapsulated and no longer reachable by reflection, so libraries that call setAccessible on them fail with InaccessibleObjectException.",
        context="Running an older library or application (Hadoop, Spark, Mockito, serialisation libraries) on Java 17.",
        failed_approaches=("cd /w && java --illegal-access=permit M.java 2>&1", "cd /w && java -Djdk.module.illegalAccess=permit M.java 2>&1"),
        fix="cd /w && java --add-opens java.base/java.lang=ALL-UNNAMED M.java", verify="cd /w && java --add-opens java.base/java.lang=ALL-UNNAMED M.java && echo opened",
        root_cause="Java 16 made strong encapsulation the default and Java 17 removed the --illegal-access escape hatch. A package of a JDK module can be used reflectively only if it is opened explicitly to the caller.",
        steps=("Pass --add-opens <module>/<package>=ALL-UNNAMED for the package named in the error message.", "Upgrade the library to a release that supports Java 17 and no longer needs it.", "Put the flags in JAVA_TOOL_OPTIONS or the application's launcher script so that every JVM start has them."),
        tags=("java", "java17", "jpms", "reflection"), message="InaccessibleObjectException",
    ),
    from_probe(
        "jvm-classfile-65-on-17", category="runtime", error_type="UnsupportedClassVersionError", runtime=J17, memory="1g",
        summary="A class compiled for a newer Java than the one running it fails with UnsupportedClassVersionError, which names the class file version (65 is Java 21).",
        context="Running a jar on a server or container with an older JRE than the one the build used.",
        failed_approaches=("cd /w && java -XX:+IgnoreUnrecognizedVMOptions Hello 2>&1", "cd /w && java --enable-preview Hello 2>&1"),
        fix="cd /w && javac --release 17 Hello.java && java Hello", verify="cd /w && java Hello",
        root_cause="javac stamps each class with a major version (61 for Java 17, 65 for Java 21), and a JVM refuses classes newer than itself. The build used a newer JDK than the runtime.",
        steps=("Run on a JRE at least as new as the one that compiled the class, or", "compile with --release <runtime version> (maven.compiler.release in Maven, options.release in Gradle) so that the output targets the older runtime."),
        tags=("java", "class-file-version", "jdk-mismatch"), message="UnsupportedClassVersionError",
    ),
    from_probe(
        "jvm-gradle73-jdk21", category="tooling", error_type="Unsupported class file major version", runtime=J21, memory="3g",
        summary="Gradle 7.3 cannot run on JDK 21, because it cannot read its class files and stops with Unsupported class file major version 65 before building anything.",
        context="Running an old Gradle wrapper on a machine or CI image that moved to Java 21.",
        failed_approaches=("/opt/gradle-7.3.3/bin/gradle --no-daemon -Dorg.gradle.java.home=$JAVA_HOME help 2>&1", "JAVA_HOME=$JAVA_HOME /opt/gradle-7.3.3/bin/gradle --no-daemon --info help 2>&1"),
        fix="curl -fsSLo /tmp/g8.zip https://services.gradle.org/distributions/gradle-8.5-bin.zip && unzip -q /tmp/g8.zip -d /opt && cd /w && /opt/gradle-8.5/bin/gradle --no-daemon help",
        verify="cd /w && /opt/gradle-8.5/bin/gradle --no-daemon --version",
        root_cause="Each Gradle release can run on a limited range of JDKs. Gradle 8.5 is the first to run on Java 21; older releases cannot parse the newer class files of the JDK itself.",
        steps=("Upgrade Gradle (./gradlew wrapper --gradle-version 8.5 or later), or", "run Gradle on a JDK it supports (JAVA_HOME pointing at 17) and let toolchains build with the JDK you want."),
        tags=("java", "gradle", "jdk21", "compatibility"), message="Unsupported class file major version",
    ),
)

TASKS += (
    from_probe(
        "jvm-gradle-toolchain-not-found", category="build", error_type="No matching toolchains found", runtime={"name": "java", "version": "17"}, memory="3g",
        summary="Gradle cannot find a JDK for a java toolchain it asks for (languageVersion 21) when only JDK 17 is installed and automatic download is off.",
        context="Building a project that declares a toolchain on a machine or CI image with a different JDK.",
        failed_approaches=("cd /w && /opt/gradle-8.10.2/bin/gradle --no-daemon -Dorg.gradle.java.home=$JAVA_HOME compileJava 2>&1", "cd /w && /opt/gradle-8.10.2/bin/gradle --no-daemon --offline compileJava 2>&1"),
        fix="cd /w && sed -i 's/of(21)/of(17)/' build.gradle && /opt/gradle-8.10.2/bin/gradle --no-daemon compileJava", verify="cd /w && ls build/classes/java/main/A.class",
        root_cause="A toolchain is the JDK a build asks for, independent of the JDK Gradle itself runs on. Gradle looks for it among the installed JDKs and, if allowed, downloads it through a toolchain resolver; org.gradle.java.home does not satisfy it.",
        steps=("Install the JDK the toolchain names, or change languageVersion to one that is installed.", "Or let Gradle download it: apply the foojay toolchain resolver plugin in settings.gradle and leave automatic download on.", "In CI, base the image on the JDK the project needs."),
        tags=("java", "gradle", "toolchain", "jdk"), message="Cannot find a Java installation",
    ),
)

TASKS += (
    from_probe(
        "jvm-gradle-compile-configuration-removed", category="build", error_type="Could not find method compile()", runtime={"name": "java", "version": "17"}, memory="3g",
        summary="Gradle 7 and later fail with Could not find method compile() because the compile and runtime dependency configurations were removed; build scripts written for Gradle 6 still use them.",
        context="Running an old project, or an old tutorial's build.gradle, with a current Gradle.",
        failed_approaches=("cd /w && /opt/gradle-8.10.2/bin/gradle --no-daemon dependencies 2>&1", "cd /w && /opt/gradle-8.10.2/bin/gradle --no-daemon --offline build 2>&1"),
        fix="""cd /w && sed -i 's/compile "/implementation "/' build.gradle""", verify="cd /w && /opt/gradle-8.10.2/bin/gradle --no-daemon -q help && echo ok",
        root_cause="Gradle deprecated compile and runtime in 4.x and removed them in 7.0. implementation (for dependencies the module uses) and api (for those it exposes, with the java-library plugin) replace compile; runtimeOnly replaces runtime.",
        steps=("Replace compile with implementation (or api for a library's public dependencies), testCompile with testImplementation, runtime with runtimeOnly.", "Or run the build with the Gradle version it was written for, through its wrapper, while you migrate."),
        tags=("java", "gradle", "gradle7", "removed-configuration"), message="Could not find method compile()",
    ),
)

TASKS += (
    from_probe(
        "jvm-maven-no-pom", category="tooling", error_type="MissingProjectException", runtime=J17, memory="2g",
        summary="mvn fails with The goal you specified requires a project to execute but there is no POM in this directory when it runs in a folder without a pom.xml.",
        context="Running mvn package or install from the wrong folder, such as the repository root of a project whose pom.xml is one level down.",
        failed_approaches=("cd /w && mvn -q -U package 2>&1", "cd /w && mvn -q clean install 2>&1"),
        extra_setup="""mkdir -p /w/app && printf '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>x</groupId><artifactId>app</artifactId><version>1</version><packaging>pom</packaging></project>' > /w/app/pom.xml""",
        fix="cd /w/app && mvn -q package && echo built", verify="cd /w/app && mvn -q package && echo built",
        root_cause="Lifecycle phases such as package belong to a project, and Maven finds the project by reading pom.xml in the current folder. With none there is nothing to build, and flags like -U (update snapshots) or the clean phase do not change that.",
        steps=("cd into the folder with the pom.xml, or point at it with mvn -f path/to/pom.xml package.", "Check that the file is named pom.xml exactly and that the checkout is complete."),
        tags=("maven", "pom", "cli"), message="requires a project to execute",
    ),
)

TASKS += (
    from_probe(
        "jvm-maven-unknown-lifecycle-phase", category="tooling", error_type="Unknown lifecycle phase", runtime=J17, memory="2g",
        summary="mvn fails with Unknown lifecycle phase pakage, You must specify a valid lifecycle phase or a goal in the format plugin-prefix:goal, when the phase name is mistyped or is not a Maven phase.",
        context="Running mvn with a misspelled phase, or with a Gradle or npm task name, in a Maven project.",
        failed_approaches=("cd /w && mvn -q -U pakage 2>&1", "cd /w && mvn -q clean pakage 2>&1"),
        fix="cd /w && mvn -q package && echo built", verify="cd /w && mvn -q package && echo built",
        root_cause="Maven takes each argument as a lifecycle phase (validate, compile, test, package, verify, install, deploy, clean...) or as plugin:goal. A word that is neither is rejected before anything runs, and options such as -U or an extra clean phase do not rename it.",
        steps=("Fix the spelling: the phases are listed in the Maven lifecycle reference (validate, compile, test, package, verify, install, deploy).", "To run a plugin goal use plugin-prefix:goal, for example dependency:tree."),
        tags=("maven", "lifecycle", "typo", "cli"), message="Unknown lifecycle phase",
    ),
)
