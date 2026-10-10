import 'dart:convert';
import 'dart:io';

import 'crypto.dart';
import 'models.dart';

class VaultFile {
  const VaultFile(this.file);
  final File file;

  Future<bool> exists() => file.exists();

  Future<VaultData> read(List<int> key) async {
    final clear = await VaultCrypto.decrypt(await file.readAsString(), key);
    return VaultData.fromJson(
      jsonDecode(utf8.decode(clear)) as Map<String, dynamic>,
    );
  }

  Future<void> write(VaultData data, List<int> key) async {
    final content = await VaultCrypto.encrypt(
      utf8.encode(jsonEncode(data.toJson())),
      key,
    );
    await file.parent.create(recursive: true);
    final temporary = File('${file.path}.tmp');
    await temporary.writeAsString(content, flush: true);
    await temporary.rename(file.path);
  }
}
