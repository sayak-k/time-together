plugins {
    id(libs.plugins.javaLibrary.get().pluginId)
    alias(libs.plugins.kotlinLibrary)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

dependencies {
    api(project(":domain:common"))

    api(libs.javax)
    api(libs.coroutines)
    api(libs.timber)
    api(libs.kotlin)

    testImplementation(libs.test.junit)
    testImplementation(libs.test.mockitoKotlin)
}
