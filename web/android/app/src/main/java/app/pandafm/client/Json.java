package app.pandafm.client;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A small, strict JSON reader/writer with no Android dependency (org.json is a
 * stub in plain JUnit). Objects are LinkedHashMap, arrays ArrayList, numbers
 * Long or Double. Used for the native queue, its persistence and PandaFM API
 * responses.
 */
final class Json {
    private final String s;
    private int i;

    private Json(String s) {
        this.s = s;
    }

    static Object parse(String text) {
        if (text == null) throw new IllegalArgumentException("no JSON");
        Json p = new Json(text);
        p.ws();
        Object v = p.value();
        p.ws();
        if (p.i != p.s.length()) throw new IllegalArgumentException("trailing characters at " + p.i);
        return v;
    }

    /** Parse, or null for anything malformed (persisted state must never crash the service). */
    static Object tryParse(String text) {
        try {
            return parse(text);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private void ws() {
        while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
    }

    private Object value() {
        if (i >= s.length()) throw new IllegalArgumentException("unexpected end");
        char c = s.charAt(i);
        if (c == '{') return object();
        if (c == '[') return array();
        if (c == '"') return string();
        if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
        if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
        if (s.startsWith("null", i)) { i += 4; return null; }
        return number();
    }

    private Map<String, Object> object() {
        Map<String, Object> m = new LinkedHashMap<>();
        i++;
        ws();
        if (peek('}')) { i++; return m; }
        while (true) {
            ws();
            if (!peek('"')) throw new IllegalArgumentException("expected key at " + i);
            String k = string();
            ws();
            expect(':');
            ws();
            m.put(k, value());
            ws();
            if (peek(',')) { i++; continue; }
            expect('}');
            return m;
        }
    }

    private List<Object> array() {
        List<Object> a = new ArrayList<>();
        i++;
        ws();
        if (peek(']')) { i++; return a; }
        while (true) {
            ws();
            a.add(value());
            ws();
            if (peek(',')) { i++; continue; }
            expect(']');
            return a;
        }
    }

    private String string() {
        expect('"');
        StringBuilder b = new StringBuilder();
        while (true) {
            if (i >= s.length()) throw new IllegalArgumentException("unterminated string");
            char c = s.charAt(i++);
            if (c == '"') return b.toString();
            if (c != '\\') { b.append(c); continue; }
            char e = s.charAt(i++);
            switch (e) {
                case 'n': b.append('\n'); break;
                case 't': b.append('\t'); break;
                case 'r': b.append('\r'); break;
                case 'b': b.append('\b'); break;
                case 'f': b.append('\f'); break;
                case 'u': b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                default: b.append(e);
            }
        }
    }

    private Object number() {
        int start = i;
        while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
        String n = s.substring(start, i);
        if (n.isEmpty()) throw new IllegalArgumentException("unexpected character at " + start);
        if (n.contains(".") || n.contains("e") || n.contains("E")) return Double.parseDouble(n);
        return Long.parseLong(n);
    }

    private boolean peek(char c) {
        return i < s.length() && s.charAt(i) == c;
    }

    private void expect(char c) {
        if (!peek(c)) throw new IllegalArgumentException("expected '" + c + "' at " + i);
        i++;
    }

    static String write(Object v) {
        StringBuilder b = new StringBuilder();
        write(b, v);
        return b.toString();
    }

    @SuppressWarnings("unchecked")
    private static void write(StringBuilder b, Object v) {
        if (v == null) b.append("null");
        else if (v instanceof String) b.append(MiniJson.quote((String) v));
        else if (v instanceof Boolean || v instanceof Long || v instanceof Integer) b.append(v);
        else if (v instanceof Double || v instanceof Float) {
            double d = ((Number) v).doubleValue();
            b.append(Double.isFinite(d) ? (d == Math.rint(d) && Math.abs(d) < 1e15 ? String.valueOf((long) d) : String.valueOf(d)) : "null");
        } else if (v instanceof Map) {
            b.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) {
                if (!first) b.append(',');
                first = false;
                b.append(MiniJson.quote(e.getKey())).append(':');
                write(b, e.getValue());
            }
            b.append('}');
        } else if (v instanceof List) {
            b.append('[');
            boolean first = true;
            for (Object o : (List<Object>) v) {
                if (!first) b.append(',');
                first = false;
                write(b, o);
            }
            b.append(']');
        } else b.append(MiniJson.quote(String.valueOf(v)));
    }

    // ── small typed accessors ──
    @SuppressWarnings("unchecked")
    static Map<String, Object> map(Object o) {
        return o instanceof Map ? (Map<String, Object>) o : null;
    }

    @SuppressWarnings("unchecked")
    static List<Object> list(Object o) {
        return o instanceof List ? (List<Object>) o : null;
    }

    static String str(Map<String, Object> m, String k) {
        Object v = m == null ? null : m.get(k);
        return v instanceof String ? (String) v : null;
    }

    static Long num(Map<String, Object> m, String k) {
        Object v = m == null ? null : m.get(k);
        return v instanceof Number ? ((Number) v).longValue() : null;
    }

    static boolean bool(Map<String, Object> m, String k) {
        return m != null && Boolean.TRUE.equals(m.get(k));
    }

    static List<Map<String, Object>> maps(Object o) {
        List<Map<String, Object>> out = new ArrayList<>();
        List<Object> l = list(o);
        if (l != null) for (Object x : l) if (map(x) != null) out.add(map(x));
        return out;
    }
}
