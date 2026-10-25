package app.pandafm.client;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Just enough JSON for PandaFM's auth calls, with no Android dependency (so plain JUnit can test AuthCore). */
final class MiniJson {
    private MiniJson() {}

    static String quote(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append('"').toString();
    }

    static String string(String json, String key) {
        if (json == null) return null;
        Matcher m = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(json);
        if (!m.find()) return null;
        String raw = m.group(1);
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c != '\\' || i + 1 >= raw.length()) { out.append(c); continue; }
            char n = raw.charAt(++i);
            switch (n) {
                case 'n': out.append('\n'); break;
                case 't': out.append('\t'); break;
                case 'r': out.append('\r'); break;
                case 'b': out.append('\b'); break;
                case 'f': out.append('\f'); break;
                case 'u':
                    if (i + 4 < raw.length()) { out.append((char) Integer.parseInt(raw.substring(i + 1, i + 5), 16)); i += 4; }
                    break;
                default: out.append(n);
            }
        }
        return out.toString();
    }

    static Long number(String json, String key) {
        if (json == null) return null;
        Matcher m = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*(-?\\d+)").matcher(json);
        return m.find() ? Long.parseLong(m.group(1)) : null;
    }
}
