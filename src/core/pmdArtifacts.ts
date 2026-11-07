/*
 * PMD 7.29.0 for Java: the runtime jars of net.sourceforge.pmd:pmd-java and
 * :pmd-cli (without the optional GUI designer), as resolved by Maven.
 * Checksums were verified against the .sha1 files Maven Central publishes;
 * downloads are rejected unless their SHA-256 matches.
 *
 * To update: resolve pmd-java + pmd-cli <version> with
 * `mvn dependency:copy-dependencies -DincludeScope=runtime -Dmdep.useRepositoryLayout=true`,
 * drop pmd-designer, and regenerate this list (path, sha256, size).
 */

export const PMD_VERSION = '7.29.0';
export const PMD_MAIN_CLASS = 'net.sourceforge.pmd.cli.PmdCli';

export interface MavenArtifact {
  /** Path below the repository root, e.g. net/sourceforge/pmd/pmd-core/7.29.0/pmd-core-7.29.0.jar */
  path: string;
  sha256: string;
  size: number;
}

export const PMD_ARTIFACTS: readonly MavenArtifact[] = [
  { path: 'com/github/oowekyala/ooxml/nice-xml-messages/3.1/nice-xml-messages-3.1.jar', sha256: '0b4ceb5b8362d43c9c6c49b1bd57f1c5da54d3c5c7c305fa39c0a04462bb4799', size: 48648 },
  { path: 'com/google/code/gson/gson/2.15.0/gson-2.15.0.jar', sha256: '96d3dd843dc2911de01cdabcd50064cb9e860353102a0a78c96fd833d396fc7d', size: 316396 },
  { path: 'com/google/errorprone/error_prone_annotations/2.50.0/error_prone_annotations-2.50.0.jar', sha256: '4667724877f1d37a689202da191e23efa7657c62eef93ccdac406eccfe5cdd0a', size: 20252 },
  { path: 'commons-io/commons-io/2.22.0/commons-io-2.22.0.jar', sha256: '2b9a7b1f726fb86216dbd2c8321eabe0221dbd5b1be81c18e1cb53811b104758', size: 609182 },
  { path: 'info/picocli/picocli/4.7.7/picocli-4.7.7.jar', sha256: 'f86e30fffd10d2b13b8caa8d4b237a7ee61f2ffccf5b1941de718b765d235bf8', size: 417640 },
  { path: 'me/tongfei/progressbar/0.10.2/progressbar-0.10.2.jar', sha256: '9979afcfc1967bacd98b3afc74499501028d294aa65fb3f9139cd79742111e81', size: 38741 },
  { path: 'net/sf/saxon/Saxon-HE/12.10/Saxon-HE-12.10.jar', sha256: 'b571af282f25d7301059f788b9a149aab8b5cdc14ef3d212dc5425d3dcbb9a97', size: 5793277 },
  { path: 'net/sourceforge/pmd/pmd-cli/7.29.0/pmd-cli-7.29.0.jar', sha256: 'e9f2e3cb9f1acc61b6d403b96449f2f24773bf02de54921aea8158ac887f0c04', size: 54185 },
  { path: 'net/sourceforge/pmd/pmd-core/7.29.0/pmd-core-7.29.0.jar', sha256: 'f73a3236b8d312eb90fdc3c5ef33252f873bc152f1a764e64736dfb726d62962', size: 1009794 },
  { path: 'net/sourceforge/pmd/pmd-java/7.29.0/pmd-java-7.29.0.jar', sha256: 'd4299d5b5f951f4812657a26f95790b77dbb6c84a80c8ae04e0c87db5fde2966', size: 1908052 },
  { path: 'org/antlr/antlr4-runtime/4.13.2/antlr4-runtime-4.13.2.jar', sha256: 'dd3e8a13a2d669bf84fb8d834de35ce4875f27157698d206241ec8488aadcaf7', size: 326307 },
  { path: 'org/apache/commons/commons-lang3/3.21.0/commons-lang3-3.21.0.jar', sha256: 'a2af247ec4db6eb8947e18e23e0433e4871a7c5d0a40e1f92e46ede54ae1defe', size: 749083 },
  { path: 'org/checkerframework/checker-qual/3.55.1/checker-qual-3.55.1.jar', sha256: '857658c8bdcbff794949a8d9922f88d63ee3751c203c7cd7d21ea97f9e745288', size: 241885 },
  { path: 'org/jline/jline-native/3.29.0/jline-native-3.29.0.jar', sha256: '19cfcc9d3c78a1c6cfe4c6c9599f16a657e4bf8da43940fc4b875373236dc258', size: 190157 },
  { path: 'org/jline/jline-terminal/3.29.0/jline-terminal-3.29.0.jar', sha256: 'fd68a98b32b1132035c62102e5df0b0fdc358e7c87a9f876ce7071450b4d10da', size: 264973 },
  { path: 'org/ow2/asm/asm/9.11.1/asm-9.11.1.jar', sha256: 'ae4e6e10d59d0a1500317764b21881ad883f8550e33c66e6142f7032c6fb566c', size: 131138 },
  { path: 'org/pcollections/pcollections/4.0.2/pcollections-4.0.2.jar', sha256: '2bbeef5797a241300c4f7513cd546239629ed7deda4fc0c31df90bb95f5f13ef', size: 73718 },
  { path: 'org/slf4j/jul-to-slf4j/1.7.36/jul-to-slf4j-1.7.36.jar', sha256: '9e641fb142c5f0b0623d6222c09ea87523a41bf6bed48ac79940724010b989de', size: 4519 },
  { path: 'org/slf4j/slf4j-api/1.7.36/slf4j-api-1.7.36.jar', sha256: 'd3ef575e3e4979678dc01bf1dcce51021493b4d11fb7f1be8ad982877c16a1c0', size: 41125 },
  { path: 'org/slf4j/slf4j-simple/1.7.36/slf4j-simple-1.7.36.jar', sha256: '2f39bed943d624dfa8f4102d0571283a10870b6aa36f197a8a506f147010c10f', size: 15333 },
  { path: 'org/xmlresolver/xmlresolver/5.3.3/xmlresolver-5.3.3-data.jar', sha256: 'b0c487ad2f3e558be8d829c916d2458d10aca6a5bafa7a4d0524b70845e48a5c', size: 1033122 },
  { path: 'org/xmlresolver/xmlresolver/5.3.3/xmlresolver-5.3.3.jar', sha256: '1fe4d5b92f708dcdb82dbce12919e0171e6b5ca62c6dca6220483625098feb5f', size: 167889 },
];
