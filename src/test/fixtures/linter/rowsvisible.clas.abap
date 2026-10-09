CLASS zcl_fixture_rowsvisible DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.

    TYPES:
      BEGIN OF ty_s_row,
        name   TYPE string,
        hidden TYPE abap_bool,
      END OF ty_s_row.
    TYPES ty_t_row TYPE STANDARD TABLE OF ty_s_row WITH EMPTY KEY.

    DATA t_rows TYPE ty_t_row.
    DATA t_plain TYPE ty_t_row.
    DATA hide TYPE abap_bool VALUE abap_true.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.

    METHODS view_display.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_fixture_rowsvisible IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_navigated( ).
      view_display( ).
    ENDIF.

  ENDMETHOD.


  METHOD view_display.

    " a comment that says the row's " visible " flag does not end the scan
    DATA(page) = z2ui5_cl_ui5_view_builder=>factory( )->ele( n = `View` ns = `mvc`
        )->a( n = `xmlns`     v = `sap.m`
        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`
        )->ele( `Page` ).

    " rows hidden on the client - the hidden ones count against the 100
    page->ele( `List`
        )->a( n = `items` v = client->_bind( t_rows )
        )->ele( `items`
            )->tag( `StandardListItem`
                )->a( n = `title`   v = `{NAME}`
                )->a( n = `visible` v = |\{= !(${ client->_bind( hide ) } && $\{HIDDEN\}) \}| ).

    " no visible binding on the template - not this rule
    page->ele( `List`
        )->a( n = `items` v = client->_bind( t_plain )
        )->ele( `items`
            )->tag( `StandardListItem`
                )->a( n = `title` v = `{NAME}` ).

    " prose naming cs_event-set_size_limit is a literal, not a raise
    page->tag( `Text`
        )->a( n = `text` v = `see cs_event-set_size_limit in the guide` ).

    client->view_display( page->stringify( ) ).

  ENDMETHOD.

ENDCLASS.
